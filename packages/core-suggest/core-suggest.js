import { closest, dispatchEvent, escapeHTML, IS_IE11, IS_IOS, queryAll, toggleAttribute } from '../utils'

const KEYS = { ENTER: 13, ESC: 27, PAGEUP: 33, PAGEDOWN: 34, END: 35, HOME: 36, UP: 38, DOWN: 40 }
const AJAX_DEBOUNCE = 500

export default class CoreSuggest extends HTMLElement {
  static get observedAttributes () { return ['hidden', 'highlight'] }

  connectedCallback () {
    this._observer = new window.MutationObserver(() => onMutation(this)) // Enhance <a> and <button> markup
    this._observer.observe(this, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] })
    this._xhr = new window.XMLHttpRequest()

    if (IS_IOS) this.input.setAttribute('role', 'combobox') // iOS does not inform about editability if combobox
    this.input.setAttribute('autocomplete', 'off')
    this.input.setAttribute('aria-autocomplete', 'list')
    this.input.setAttribute('aria-expanded', false)

    document.addEventListener('click', this)
    document.addEventListener('input', this)
    document.addEventListener('keydown', this)
    document.addEventListener('focusin', this)
    setTimeout(() => onMutation(this)) // Ensure limit is respected
    if (document.activeElement === this.input) this.hidden = false // Open if active
  }

  disconnectedCallback () {
    document.removeEventListener('click', this)
    document.removeEventListener('input', this)
    document.removeEventListener('keydown', this)
    document.removeEventListener('focusin', this)
    // Clear internals to aid garbage collection
    this._observer.disconnect()
    this._observer = this._input = this._regex = this._xhr = null
  }

  attributeChangedCallback (name, prev, next) {
    if (!this._observer) return
    if (name === 'hidden') this.input.setAttribute('aria-expanded', !this.hidden)
    if (name === 'highlight') onMutation(this)
  }

  /**
   * Use `focusin` because it bubbles (`focus` does not)
   * @param {KeyboardEvent | FocusEvent | InputEvent | MouseEvent} event
   */
  handleEvent (event) {
    if (event.ctrlKey || event.altKey || event.metaKey || event.defaultPrevented) return
    if (event.type === 'focusin' || event.type === 'click') onClick(this, event)
    if (event.type === 'keydown') onKey(this, event)
    if (event.type === 'input') onInput(this, event)
  }

  escapeHTML (str) { return escapeHTML(str) }

  get input () {
    if (this._input && this._input.getAttribute('list') === this.id) return this._input // Speed up
    return (this._input = this.id && document.querySelector(`input[list=${this.id}]`)) || this.previousElementSibling
  }

  // Always return string consistent with .value or .className
  get ajax () { return this.getAttribute('ajax') || '' }

  set ajax (url) { this.setAttribute('ajax', url) }

  get limit () { return Math.max(0, this.getAttribute('limit')) || Infinity }

  set limit (int) { this.setAttribute('limit', int) }

  /**
   * @returns {'on' | 'off' | 'keep'} defaults to `'on'`
   */
  get highlight () {
    return String(/^on|off|keep$/i.exec(this.getAttribute('highlight')) || 'on').toLowerCase()
  }

  set highlight (str) { this.setAttribute('highlight', str) }

  // Must set attribute for IE11
  get hidden () { return this.hasAttribute('hidden') }

  set hidden (val) { toggleAttribute(this, 'hidden', val) }
}

/**
 * @param {CoreSuggest} self Core suggest element
 * @returns {HTMLSpanElement}
 */
function appendResultsNotificationSpan (self) {
  if (!self._observer) return // Abort if disconnectedCallback has been called
  const resultsNotificationSpan = document.createElement('span')
  resultsNotificationSpan.setAttribute('aria-live', 'polite')
  resultsNotificationSpan.setAttribute('style', `
    position: absolute !important;
    overflow: hidden !important;
    width: 1px !important;
    height: 1px !important;
    clip: rect(0, 0, 0, 0) !important;
  `)
  self.appendChild(resultsNotificationSpan)
  return resultsNotificationSpan
}

/**
 * Sets textContent for resultsShownSpan to notify screen readers whenever results are visible
 * Adds a timeout to clear textContent after 2000 ms
 *
 * @param {CoreSuggest} self Core suggest element
 * @param {Boolean} clear defaults to false. Flag to remove textContent of existing node
 * @returns {void}
 */
function notifyResultsVisible (self, clear = false) {
  if (!self._observer) return // Abort if disconnectedCallback has been called

  if (clear) {
    self._clearLiveRegion()
  } else {
    const label = self.getAttribute('data-live-label-visible') || 'Søkeresultater vises'
    self._pushToLiveRegion(label)
  }
}

/**
 * @param {Element} item
 * @param {Boolean} show
 */
function toggleItem (item, show) {
  const li = item.parentElement // JAWS requires hiding parent <li> (if existing)
  if (li.nodeName === 'LI') toggleAttribute(li, 'hidden', show)
  toggleAttribute(item, 'hidden', show)
}

/**
 * Callback for mutationObserver
 * Enhances items with aria-label, tabindex and type="button"
 * Respects limit attribute
 * Updates <mark> tags for highlighting according to attribute
 * This can happen quite frequently so make it fast
 * @param {CoreSuggest} self Core suggest element
 * @returns {void}
 */
function onMutation (self) {
  if (!self._observer) return // Abort if disconnectedCallback has been called (this/self._observer is null)

  const needle = self.input.value.toLowerCase().trim()
  const items = self.querySelectorAll('a:not([hidden]),button:not([hidden])')
  const limit = Math.min(items.length, self.limit)

  // Remove old highlights only when highlight-mode is not 'keep'
  if (self.highlight !== 'keep') {
    const marks = self.getElementsByTagName('mark')
    while (marks[0]) {
      const parent = marks[0].parentNode
      parent.replaceChild(document.createTextNode(marks[0].textContent), marks[0])
      parent.normalize && parent.normalize()
    }
  }

  for (let i = 0, l = items.length; i < l; ++i) {
    items[i].setAttribute('aria-label', `${items[i].textContent}, ${i + 1} av ${limit}`)
    items[i].setAttribute('tabindex', '-1') // setAttribute a bit faster than tabIndex prop
    items[i].setAttribute('type', 'button') // Ensure <button> does not submit forms
    toggleItem(items[i], i >= limit)
  }

  // Highlights disabled for IE11 due to bugs in range calculation
  if (needle && self.highlight === 'on' && !IS_IE11) {
    const range = document.createRange()
    const iterator = document.createNodeIterator(self, window.NodeFilter.SHOW_TEXT, null, false)
    const haystack = self.textContent.toLowerCase()
    const length = needle.length
    const hits = []

    for (let start = 0; (start = haystack.indexOf(needle, start)) !== -1; start += length) hits.push(start)
    for (let start = 0, hitsLength = hits.length, node; (node = iterator.nextNode());) {
      const nodeStart = start
      const nodeEnd = start += node.textContent.length

      for (let i = 0; i < hitsLength; ++i) {
        const hitStart = Math.max(hits[i] - nodeStart, 0) // Avoid splitting at minus index
        const hitEnd = Math.min(nodeEnd, hits[i] + length) - nodeStart // Avoid splitting after content end
        if (hitStart < hitEnd) {
          range.setStart(node, hitStart)
          range.setEnd(node, hitEnd)
          range.surroundContents(document.createElement('mark'))
          start = nodeStart + hitEnd // Reset start to character after <mark>
          iterator.nextNode() // skip newly created node next
          break
        }
      }
    }
  }
  self._observer.takeRecords() // Empty mutation queue to skip mutations done by highlighting
}

/**
 * Handle input event in connected input
 * Performs filtering of core-suggest items
 * Dispatches event
 *  * `suggest.filter`
 * @param {CoreSuggest} self Core suggest element
 * @param {InputEvent} event
 * @returns {void}
 */
function onInput (self, event) {
  if (event.target !== self.input || !dispatchEvent(self, 'suggest.filter') || onAjax(self)) return
  const value = self.input.value.toLowerCase()
  const items = self.querySelectorAll('a,button')

  for (let i = 0, l = items.length; i < l; ++i) {
    toggleItem(items[i], (items[i].value || items[i].textContent).toLowerCase().indexOf(value) === -1)
  }
}

/**
 *
 * @param {CoreSuggest} self Core suggest element
 * @param {KeyboardEvent} event
 * @returns {void}
 */
function onKey (self, event) {
  if (!self.contains(event.target) && self.input !== event.target) return
  const items = [self.input].concat(queryAll('[tabindex="-1"]:not([hidden])', self))
  let { keyCode, target, item = false } = event

  if (keyCode === KEYS.DOWN) item = items[items.indexOf(target) + 1] || items[0]
  else if (keyCode === KEYS.UP) item = items[items.indexOf(target) - 1] || items.pop()
  else if (self.contains(target)) { // Aditional shortcuts if focus is inside list
    if (keyCode === KEYS.END || keyCode === KEYS.PAGEDOWN) item = items.pop()
    else if (keyCode === KEYS.HOME || keyCode === KEYS.PAGEUP) item = items[1]
    else if (keyCode !== KEYS.ENTER) items[0].focus()
  }

  setTimeout(() => (self.hidden = keyCode === KEYS.ESC)) // Let focus buble first
  if (item || keyCode === KEYS.ESC) event.preventDefault() // Prevent leaving maximized safari
  if (item) item.focus()
}

/**
 * Handle focus or click events
 * Dispatches `suggest.select`
 * @param {CoreSuggest} self Core suggest element
 * @param {FocusEvent | MouseEvent} event
 * @returns {void}
 */
function onClick (self, event) {
  const item = event.type === 'click' && self.contains(event.target) && closest(event.target, 'a,button')
  const show = !item && (self.contains(event.target) || self.input === event.target)

  if (item && dispatchEvent(self, 'suggest.select', item)) {
    self.input.value = item.value || item.textContent.trim()
    self.input.focus()
  }

  // setTimeout: fix VoiceOver Safari moving focus to parentElement and let focus bubbe first
  setTimeout(() => (self.hidden = !show))
}

/**
 * Handle ajax event using ajax attribute
 * @param {CoreSuggest} self Core suggest element
 * @returns {true}
 */
function onAjax (self) {
  if (!self.ajax) return
  clearTimeout(self._xhrTime) // Clear previous search
  self._xhr.abort() // Abort previous request
  self._xhr.responseError = null
  self._xhrTime = setTimeout(onAjaxSend, AJAX_DEBOUNCE, self) // Debounce
  return true
}

/**
 * Handle ajax request, replacing `{{value}}` in ajax-attribute with URIEncoded value from input
 * Dispatches the following events
 *  * suggest.ajax.beforeSend
 *  * suggest.ajax.error
 *  * suggest.ajax
 * @param {CoreSuggest} self Core suggest element
 * @returns {void}
 */
function onAjaxSend (self) {
  if (!self._observer || !self.input.value) return // Abort if disconnectedCallback has completed or input is empty
  if (dispatchEvent(self, 'suggest.ajax.beforeSend', self._xhr)) {
    self._xhr.onerror = () => {
      self._xhr.responseError = 'Error: Network request failed'
      dispatchEvent(self, 'suggest.ajax.error', self._xhr)
    }
    self._xhr.onload = () => {
      if (self._xhr.status !== 200) return dispatchEvent(self, 'suggest.ajax.error', self._xhr)
      try {
        self._xhr.responseJSON = JSON.parse(self._xhr.responseText)
      } catch (error) {
        self._xhr.responseJSON = false
        self._xhr.responseError = error.toString()
        dispatchEvent(self, 'suggest.ajax.error', self._xhr)
      }
      dispatchEvent(self, 'suggest.ajax', self._xhr)
    }
    self._xhr.open('GET', self.ajax.replace('{{value}}', window.encodeURIComponent(self.input.value)), true)
    self._xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest') // https://en.wikipedia.org/wiki/List_of_HTTP_header_fields#Requested-With
    self._xhr.send()
  }
}

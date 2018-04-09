import React from 'react'
import dialog from './core-dialog'
import {IS_BROWSER, exclude} from '../utils'

const NO_SUPPORT = IS_BROWSER && typeof window.HTMLDialogElement === 'undefined'
const DEFAULTS = {hidden: null, onToggle: null}
if (NO_SUPPORT) DEFAULTS.open = null

export default class Dialog extends React.Component {
  componentDidMount () {
    dialog(this.el, this.props.open)
    this.el.addEventListener('dialog.toggle', this.props.onToggle)
  }
  componentWillUnmount () {
    this.el.removeEventListener('dialog.toggle', this.props.onToggle)
  }
  componentWillReceiveProps ({open}) {
    dialog(this.el, open)
  }
  render () {
    return React.createElement('dialog',
      exclude(this.props, DEFAULTS, {ref: el => (this.el = el)}),
      this.props.children)
  }
}

// Port of pglite-repl/src-webcomponent/main.tsx
import { createRoot } from 'react-dom/client'
import { createElement as h, Fragment } from 'react'
import {
  Repl,
  defaultLightThemeInit,
  defaultLightTheme,
  defaultDarkThemeInit,
  defaultDarkTheme,
} from './Repl.js'
import css from './repl-css.js'

export {
  defaultLightThemeInit,
  defaultLightTheme,
  defaultDarkThemeInit,
  defaultDarkTheme,
}

export class PGliteREPL extends HTMLElement {
  #mountPoint
  #root
  #pg
  #lightTheme
  #darkTheme

  constructor() {
    super()
    this.#mountPoint = document.createElement('div')
    this.#mountPoint.classList.add('PGliteRepl-root')
    const shadowRoot = this.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = css
    shadowRoot.appendChild(style)
    shadowRoot.appendChild(this.#mountPoint)
    this.#root = createRoot(this.#mountPoint)
  }

  static get observedAttributes() {
    return ['border', 'theme', 'show-time', 'disable-update-schema']
  }

  connectedCallback() {
    this.render()
  }

  attributeChangedCallback(_name, oldValue, newValue) {
    if (oldValue !== newValue) {
      this.render()
    }
  }

  disconnectedCallback() {
    this.#root?.unmount()
  }

  get pg() {
    return this.#pg
  }

  set pg(pg) {
    this.#pg = pg
    this.render()
  }

  get lightTheme() {
    return this.#lightTheme
  }

  set lightTheme(lightTheme) {
    this.#lightTheme = lightTheme
    this.render()
  }

  get darkTheme() {
    return this.#darkTheme
  }

  set darkTheme(darkTheme) {
    this.#darkTheme = darkTheme
    this.render()
  }

  render() {
    const border = this.hasAttribute('border')
      ? this.getAttribute('border') !== 'false'
      : undefined
    const theme = this.getAttribute('theme')
    const showTime = this.hasAttribute('show-time')
      ? this.getAttribute('show-time') !== 'false'
      : undefined
    const disableUpdateSchema = this.hasAttribute('disable-update-schema')
      ? this.getAttribute('disable-update-schema') !== 'false'
      : undefined

    const props = {
      pg: this.#pg,
      border,
      lightTheme: this.#lightTheme,
      darkTheme: this.#darkTheme,
      theme: theme || 'auto',
      showTime,
      disableUpdateSchema,
    }

    this.#root.render(
      h(
        Fragment,
        null,
        this.#pg ? h(Repl, props) : h('div', null, 'PGlite instance not provided'),
      ),
    )
  }
}

customElements.define('pglite-repl', PGliteREPL)

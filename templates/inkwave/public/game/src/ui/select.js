import { createElement as h, useState, createRoot, Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../vendor/lovbase-ui.js';

const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Keep the original imperative lobby API; all selection/keyboard/focus behavior is Base UI.
export function selectMarkup(id, label, value, options, disabled = false) {
  return `<inkwave-select id="${escape(id)}" aria-label="${escape(label)}" value="${escape(value ?? '')}" data-options="${escape(JSON.stringify(options))}" ${disabled ? 'disabled' : ''}></inkwave-select>`;
}

function GameSelect({ host }) {
  const [value, setValue] = useState(host.value);
  const options = JSON.parse(host.dataset.options);
  return h(Select, {
    value,
    disabled: host.disabled,
    onValueChange: next => {
      if (next === null) return;
      setValue(next);
      host.setAttribute('value', next);
      host.dispatchEvent(new Event('change', { bubbles: true }));
    },
  },
  h(SelectTrigger, { 'aria-label': host.getAttribute('aria-label') },
    h(SelectValue, null, options.find(option => option.value === value)?.label ?? '')),
  h(SelectContent, {
    className: 'iwl-select-popup', positionerClassName: 'iwl-select-positioner',
    alignItemWithTrigger: false,
    onKeyDown: event => event.stopPropagation(),
  }, options.map(option => h(SelectItem, {
    key: option.value, value: option.value, disabled: !!option.disabled,
  }, option.label))));
}

class InkwaveSelect extends HTMLElement {
  static observedAttributes = ['disabled'];
  get value() { return this.getAttribute('value') ?? ''; }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(value) { this.toggleAttribute('disabled', !!value); }
  connectedCallback() {
    this.root = createRoot(this);
    this.render();
  }
  attributeChangedCallback() { this.render(); }
  render() { this.root?.render(h(GameSelect, { host: this })); }
  disconnectedCallback() {
    const root = this.root;
    this.root = null;
    queueMicrotask(() => root?.unmount());
  }
}

customElements.define('inkwave-select', InkwaveSelect);

let serial = 0;
let opened;
document.addEventListener('pointerdown', event => { if (opened && !opened.root.contains(event.target)) opened.close(); });

export function dropdown({label, options, value, onChange}) {
  const root = document.createElement('div'); root.className = 'dropdown';
  const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'dropdown-trigger';
  trigger.setAttribute('aria-label', label); trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
  const list = document.createElement('div'); list.className = 'dropdown-menu'; list.id = `dropdown-${++serial}`; list.hidden = true;
  list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', label); trigger.setAttribute('aria-controls', list.id);
  let selected = options.findIndex(o => String(o.value) === String(value)); if (selected < 0) selected = 0;
  const buttons = options.map((option, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'dropdown-option'; button.tabIndex = -1;
    button.setAttribute('role', 'option'); button.textContent = option.label;
    button.onclick = () => { selected = index; sync(); close(); trigger.focus(); onChange(option.value); };
    list.append(button); return button;
  });
  function sync() {
    trigger.textContent = `${label} · ${options[selected]?.label || '暂无选项'}`;
    buttons.forEach((b, i) => b.setAttribute('aria-selected', String(i === selected)));
  }
  function close() { list.hidden = true; trigger.setAttribute('aria-expanded', 'false'); if (opened?.root === root) opened = null; }
  function open(index = selected) { opened?.close(); list.hidden = false; trigger.setAttribute('aria-expanded', 'true'); opened = {root, close}; buttons[index]?.focus(); }
  trigger.onclick = () => list.hidden ? open() : close();
  trigger.onkeydown = event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(event.key === 'ArrowUp' ? buttons.length - 1 : selected); } };
  list.onkeydown = event => {
    let index = buttons.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); close(); trigger.focus(); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[index]?.focus();
    }
  };
  root.addEventListener('focusout', event => { if (!root.contains(event.relatedTarget)) close(); });
  root.append(trigger, list); sync(); return root;
}

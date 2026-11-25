export function installNumberWheel(): () => void {
  const onWheel = (event: WheelEvent): void => {
    const input = event.target;
    if (
      !(input instanceof HTMLInputElement) ||
      (input.type !== 'number' && !input.hasAttribute('data-wheel-step')) ||
      document.activeElement !== input ||
      input.disabled ||
      input.readOnly ||
      event.ctrlKey ||
      event.deltaY === 0 ||
      !event.cancelable
    ) {
      return;
    }

    // Cancel native stepping and scroll chaining, including when a limit is reached.
    event.preventDefault();
    const step = Number(input.dataset.wheelStep ?? (input.step === 'any' ? '1' : input.step || '1'));
    if (!(step > 0 && Number.isFinite(step))) return;
    const min = Number(input.dataset.wheelMin ?? (input.min || '-Infinity'));
    const max = Number(input.dataset.wheelMax ?? (input.max || 'Infinity'));
    const current = input.value === '' ? 0 : Number(input.value);
    if (!Number.isFinite(current) || Number.isNaN(min) || Number.isNaN(max) || min > max) return;
    const next = Math.max(
      min,
      Math.min(max, Number((current + (event.deltaY < 0 ? step : -step)).toPrecision(15))),
    );
    if (!Number.isFinite(next)) return;
    const value = String(next);
    if (value === input.value) return;

    // Use the native setter so React's controlled inputs receive the input event.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  document.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => document.removeEventListener('wheel', onWheel, { capture: true });
}

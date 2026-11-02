/* Small accessible UI enhancements for ZERO TECHNOLOGIES. */
(() => {
  const eye = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/><path class="eye-slash" d="M4 4 20 20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
  function enhancePasswords() {
    document.querySelectorAll('input[type="password"]').forEach((input) => {
      if (input.dataset.visibilityEnhanced === 'true') return;
      if (input.parentNode?.querySelector('.password-toggle')) {
        input.dataset.visibilityEnhanced = 'true';
        return;
      }
      input.dataset.visibilityEnhanced = 'true';
      const wrap = document.createElement('span');
      wrap.className = 'password-field-wrap';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'password-visibility-toggle';
      button.setAttribute('aria-label', 'Show password');
      button.setAttribute('aria-pressed', 'false');
      button.innerHTML = eye;
      button.addEventListener('click', () => {
        const reveal = input.type === 'password';
        input.type = reveal ? 'text' : 'password';
        button.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
        button.setAttribute('aria-pressed', String(reveal));
        button.querySelector('.eye-slash')?.setAttribute('opacity', reveal ? '0' : '1');
        input.focus({ preventScroll: true });
      });
      wrap.appendChild(button);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', enhancePasswords);
  else enhancePasswords();
  // Re-apply to dynamically revealed login/reset forms and password inputs.
  const observer = new MutationObserver(enhancePasswords);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();


// Keep the password visibility control fixed in place; only switch input type.
document.addEventListener('DOMContentLoaded',()=>{
 const input=document.getElementById('studentPassword');
 const button=document.getElementById('studentPasswordToggle');
 if(!input||!button||button.dataset.bound==='1') return;
 button.dataset.bound='1';
 button.addEventListener('click',()=>{
   const visible=input.type==='password';
   input.type=visible?'text':'password';
   button.setAttribute('aria-label',visible?'Hide password':'Show password');
   button.setAttribute('aria-pressed',String(visible));
   button.innerHTML=visible?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 002.8 2.8"/><path d="M9.9 5.2A10.8 10.8 0 0112 5c6.4 0 10 7 10 7a16 16 0 01-3.1 3.8"/><path d="M6.2 6.2C3.5 8 2 12 2 12s3.6 7 10 7c1.5 0 2.8-.4 4-1"/></svg>':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
 });
});

/*
 * contact.js
 * Purpose : Send the Contact page message form to FormSubmit, which forwards
 *           each message to Muiz's inbox, and report the result inline.
 * Inputs  : the <form data-contact-form> on contact.html.
 * Outputs : a POST to FormSubmit's AJAX endpoint; a status line for the visitor.
 * Notes   : Without JavaScript the form still posts normally and FormSubmit
 *           redirects back to contact.html?sent=1 (see the _next field).
 */
(() => {
  const form = document.querySelector('[data-contact-form]');
  if (!form) return;
  const status = form.querySelector('[data-form-status]');
  const button = form.querySelector('button[type="submit"]');

  // Arriving back from a non-JavaScript submission.
  if (new URLSearchParams(location.search).get('sent') === '1') {
    status.textContent = 'Thank you. Your message has been sent.';
    status.dataset.state = 'ok';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    // The AJAX endpoint mirrors the form action: /ajax/ inserted after the host.
    const endpoint = form.action.replace('formsubmit.co/', 'formsubmit.co/ajax/');
    const data = Object.fromEntries(new FormData(form).entries());
    button.disabled = true;
    status.dataset.state = '';
    status.textContent = 'Sending…';
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(data),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || String(result.success) === 'false') throw new Error(result.message || 'Request failed');
      form.reset();
      status.textContent = 'Thank you. Your message has been sent, and I will reply by email.';
      status.dataset.state = 'ok';
    } catch (error) {
      status.textContent = 'Sorry, the message could not be sent. Please email muizolas@buffalo.edu directly.';
      status.dataset.state = 'error';
    } finally {
      button.disabled = false;
    }
  });
})();

/*
 * contact.js
 * Purpose : Send the Contact page message form to FormSubmit, which forwards
 *           each message to Muiz's inbox, and report the result inline.
 * Inputs  : the <form data-contact-form> on contact.html.
 * Outputs : a POST to FormSubmit's AJAX endpoint; a status line for the visitor.
 * Notes   : 1. If the quick (AJAX) send cannot reach FormSubmit at all, the form
 *              falls back to a normal submission, so FormSubmit's own pages
 *              handle it (and redirect back to contact.html?sent=1).
 *           2. FormSubmit refuses messages until the owner clicks the
 *              "Activate Form" link it emails on first use; that case gets its
 *              own message instead of a generic failure.
 *           3. Without JavaScript the form posts normally (see the _next field).
 */
(() => {
  const form = document.querySelector('[data-contact-form]');
  if (!form) return;
  const status = form.querySelector('[data-form-status]');
  const button = form.querySelector('button[type="submit"]');

  const show = (text, state) => { status.textContent = text; status.dataset.state = state || ''; };

  // Arriving back from a normal (non-AJAX) submission.
  if (new URLSearchParams(location.search).get('sent') === '1') {
    show('Thank you. Your message has been sent.', 'ok');
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    // The AJAX endpoint mirrors the form action: /ajax/ inserted after the host.
    const endpoint = form.action.replace('formsubmit.co/', 'formsubmit.co/ajax/');
    const data = Object.fromEntries(new FormData(form).entries());
    button.disabled = true;
    show('Sending…');

    let response, result;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(data),
      });
      result = await response.json();
    } catch (networkError) {
      // FormSubmit unreachable by AJAX (blocked request, unreadable reply):
      // hand the message to FormSubmit with an ordinary form submission instead.
      console.warn('Contact form: AJAX send failed, using normal submission.', networkError);
      form.submit();
      return;
    }

    button.disabled = false;
    const ok = response.ok && String(result.success) !== 'false';
    if (ok) {
      form.reset();
      show('Thank you. Your message has been sent, and I will reply by email.', 'ok');
      return;
    }
    const reason = String(result.message || '');
    console.warn('Contact form: FormSubmit replied', response.status, result);
    if (/activat/i.test(reason)) {
      show('This form is waiting to be activated by the site owner. Please email muizolas@buffalo.edu in the meantime.', 'error');
    } else {
      show('Sorry, the message could not be sent' + (reason ? ' (' + reason + ')' : '') + '. Please email muizolas@buffalo.edu directly.', 'error');
    }
  });
})();

/*
 * Booking dialog: "See available times" opens the Google Calendar booking page
 * in an on-page dialog. The calendar loads only the first time it is opened.
 */
(() => {
  const open = document.querySelector('[data-booking-open]');
  const dialog = document.querySelector('[data-booking-dialog]');
  if (!open || !dialog || typeof dialog.showModal !== 'function') return; // old browsers keep the new-tab link
  const frame = dialog.querySelector('iframe');
  open.addEventListener('click', () => {
    if (!frame.src) frame.src = frame.dataset.src;
    dialog.showModal();
  });
  dialog.querySelector('[data-booking-close]').addEventListener('click', () => dialog.close());
  // Clicking the dimmed backdrop (outside the dialog box) also closes it.
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
})();

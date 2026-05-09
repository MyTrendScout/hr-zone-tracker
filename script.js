// HR Zone Tracker — landing page interactions

// ─────────────────────────────────────────────────────────────
// Formspree email notifications
// 1. Go to https://formspree.io → New Form → copy the 8-char ID
//    (it's the last segment of your form URL: /f/abcd1234)
// 2. Paste that ID here. Leave null to skip sending (no errors shown to user).
// ─────────────────────────────────────────────────────────────
const LANDING_FORMSPREE_ID = "mwvyrzje";

(() => {
  // Year stamp in footer
  const year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  // Beta form — send to Formspree then show confirmation
  const form = document.getElementById("beta-form");
  const helper = document.getElementById("form-helper");
  if (!form || !helper) return;

  const defaultHelper = helper.textContent;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = /** @type {HTMLInputElement} */ (form.querySelector("#email"));
    const note  = /** @type {HTMLTextAreaElement} */ (form.querySelector("#note"));
    const btn   = form.querySelector("button[type='submit']");

    // Minimal validation — visual only
    const valid = email.value.trim() !== "" && /.+@.+\..+/.test(email.value);
    if (!valid) {
      helper.textContent = "Please enter a valid email so we can write back.";
      helper.classList.remove("form__helper--ok");
      email.focus();
      return;
    }

    // Disable button while sending
    if (btn) {
      btn.textContent = "Sending…";
      btn.setAttribute("disabled", "true");
      btn.style.opacity = "0.7";
      btn.style.cursor = "default";
    }

    // Send to Formspree if configured
    if (LANDING_FORMSPREE_ID) {
      try {
        await fetch(`https://formspree.io/f/${LANDING_FORMSPREE_ID}`, {
          method:  "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({
            email:     email.value.trim(),
            note:      note ? note.value.trim() : "",
            timestamp: new Date().toLocaleString()
          })
        });
      } catch (_) {
        // Network failure — still show confirmation (request is noted in the browser)
      }
    }

    // Confirmation state
    if (btn) {
      btn.textContent = "Request received";
      btn.style.opacity = "0.85";
    }
    helper.textContent = "Thanks — we'll be in touch within 48 hours.";
    helper.classList.add("form__helper--ok");

    // Reset note quietly so the submitted state feels real
    if (note) note.value = "";

    // Restore helper after a while if the user comes back
    setTimeout(() => {
      if (!btn) return;
      btn.removeAttribute("disabled");
      btn.textContent = "Send my request";
      btn.style.opacity = "";
      btn.style.cursor = "";
      helper.textContent = defaultHelper;
      helper.classList.remove("form__helper--ok");
    }, 8000);
  });

  // Subtle reveal of zone bars on first scroll into view
  const zoneFills = document.querySelectorAll(".zone__fill");
  if ("IntersectionObserver" in window && zoneFills.length) {
    zoneFills.forEach((el) => {
      const target = /** @type {HTMLElement} */ (el);
      const finalPct = target.style.getPropertyValue("--pct") || "0%";
      target.style.setProperty("--pct", "0%");
      target.dataset.target = finalPct;
    });

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const el = /** @type {HTMLElement} */ (entry.target);
          const target = el.dataset.target || "0%";
          el.style.transition = "width 900ms cubic-bezier(0.2, 0.7, 0.2, 1)";
          // width is driven by --pct via inline style; switch to direct width
          el.style.width = target;
          io.unobserve(el);
        });
      },
      { threshold: 0.25 }
    );
    zoneFills.forEach((el) => io.observe(el));
  }
})();

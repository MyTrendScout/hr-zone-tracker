// HR Zone Tracker — landing page interactions
(() => {
  // Year stamp in footer
  const year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  // Beta form — confirmation-only mockup behavior
  const form = document.getElementById("beta-form");
  const helper = document.getElementById("form-helper");
  if (!form || !helper) return;

  const defaultHelper = helper.textContent;

  form.addEventListener("submit", (e) => {
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

    // Confirmation state (mockup — no backend)
    if (btn) {
      btn.textContent = "Request received";
      btn.setAttribute("disabled", "true");
      btn.style.opacity = "0.85";
      btn.style.cursor = "default";
    }
    helper.textContent = "Thanks — we'll be in touch within 48 hours.";
    helper.classList.add("form__helper--ok");

    // Reset note quietly so the submitted state feels real
    if (note) note.value = "";

    // Restore helper after a while if the user comes back
    setTimeout(() => {
      if (!btn) return;
      btn.removeAttribute("disabled");
      btn.textContent = "Request beta access";
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

// MyPaceZone — landing page interactions

// ─────────────────────────────────────────────────────────────
// Formspree — paste your 8-char form ID here
// ─────────────────────────────────────────────────────────────
const LANDING_FORMSPREE_ID = "mwvyrzje";

// ─────────────────────────────────────────────────────────────
// Password hashing — same method as the app
// ─────────────────────────────────────────────────────────────
async function hashPassword(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

(() => {
  // Year stamp in footer
  const year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  // Beta form
  const form   = document.getElementById("beta-form");
  const helper = document.getElementById("form-helper");
  if (!form || !helper) return;

  const defaultHelper = helper.textContent;

  function showFormError(msg) {
    helper.textContent = msg;
    helper.classList.remove("form__helper--ok");
    helper.style.color = "#c62828";
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const nameEl  = form.querySelector("#ra-name");
    const emailEl = form.querySelector("#email");
    const pwEl    = form.querySelector("#ra-pw");
    const pw2El   = form.querySelector("#ra-pw2");
    const noteEl  = form.querySelector("#note");
    const btn     = form.querySelector("button[type='submit']");

    const name  = nameEl?.value.trim()  || "";
    const email = emailEl?.value.trim() || "";
    const pw    = pwEl?.value           || "";
    const pw2   = pw2El?.value          || "";
    const note  = noteEl?.value.trim()  || "";

    // Validation
    if (!name)                        { showFormError("Please enter your name.");               nameEl?.focus();  return; }
    if (!email || !/.+@.+\..+/.test(email)) { showFormError("Please enter a valid email address."); emailEl?.focus(); return; }
    if (pw.length < 6)                { showFormError("Password must be at least 6 characters."); pwEl?.focus();   return; }
    if (pw !== pw2)                   { showFormError("Passwords don't match.");                pw2El?.focus();   return; }
    if (!note)                        { showFormError("Please tell us about your training.");   noteEl?.focus();  return; }

    // Disable button while submitting
    if (btn) {
      btn.textContent = "Sending…";
      btn.setAttribute("disabled", "true");
      btn.style.opacity = "0.7";
    }
    helper.style.color = "";

    try {
      const passwordHash = await hashPassword(pw);

      // Initialize Firebase if not already done
      if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      const db = firebase.firestore();
      const existing = await db.collection("approvedUsers").where("passwordHash", "==", passwordHash).get();
      if (!existing.empty) {
        showFormError("That password is already in use — please choose a different one.");
        if (btn) { btn.removeAttribute("disabled"); btn.textContent = "Send my request"; btn.style.opacity = ""; }
        pwEl?.focus();
        return;
      }

      // Save to Firebase signupRequests
      await db.collection("signupRequests").add({
        name, email, passwordHash, note,
        status:      "pending",
        source:      "landing-page",
        requestedAt: new Date().toISOString()
      });

      // Notify admin via Formspree
      if (LANDING_FORMSPREE_ID) {
        await fetch(`https://formspree.io/f/${LANDING_FORMSPREE_ID}`, {
          method:  "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({ name, email, note, timestamp: new Date().toLocaleString() })
        }).catch(() => {});
      }

      // Success state
      if (btn) { btn.textContent = "Request received ✓"; btn.style.opacity = "0.85"; }
      helper.textContent = "Thanks! We'll review your request and email you within 48 hours.";
      helper.classList.add("form__helper--ok");
      helper.style.color = "";
      if (noteEl) noteEl.value = "";

      // Reset after a while
      setTimeout(() => {
        if (!btn) return;
        btn.removeAttribute("disabled");
        btn.textContent = "Send my request";
        btn.style.opacity = "";
        helper.textContent = defaultHelper;
        helper.classList.remove("form__helper--ok");
      }, 10000);

    } catch (err) {
      showFormError("Something went wrong — please try again.");
      if (btn) { btn.removeAttribute("disabled"); btn.textContent = "Send my request"; btn.style.opacity = ""; }
    }
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
          el.style.width = target;
          io.unobserve(el);
        });
      },
      { threshold: 0.25 }
    );
    zoneFills.forEach((el) => io.observe(el));
  }
})();

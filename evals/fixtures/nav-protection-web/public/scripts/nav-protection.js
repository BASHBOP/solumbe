(function () {
  const TRUSTED_DOMAINS = ["bashbop.example", "checkout.stripe.example"];
  const BLOCKED_PATTERNS = [/javascript:/i, /data:/i];

  const isTrusted = (url) => {
    const host = new URL(url, window.location.href).host;
    return TRUSTED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
  };

  window.addEventListener("click", (event) => {
    const link = event.target.closest("a[href]");
    if (!link) return;
    if (BLOCKED_PATTERNS.some((pattern) => pattern.test(link.href)) || !isTrusted(link.href)) {
      event.preventDefault();
    }
  });
})();

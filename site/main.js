// API Client Importer landing page: progressive enhancement only. Every feature here is optional.
// The inline head script adds the "js" class; this file adds "js-ready" once the theme toggle and the
// menu work. Without "js-ready" at DOMContentLoaded the head script removes "js" again, so the page
// falls back to the no-JS layout when this file does not load or fails early.
(function () {
  'use strict';

  const root = document.documentElement;
  const THEME_KEY = 'api-client-theme';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const live = document.getElementById('live-region');

  function announce(message) {
    if (!live) return;
    live.textContent = '';
    window.setTimeout(() => { live.textContent = message; }, 60);
  }

  function onMediaChange(query, listener) {
    if (typeof query.addEventListener === 'function') query.addEventListener('change', listener);
    else if (typeof query.addListener === 'function') query.addListener(listener);
  }

  // Theme toggle: dark by default; a stored explicit choice switches to light (or back).
  function setupTheme() {
    const button = document.querySelector('[data-theme-toggle]');
    if (!button) return;
    const metas = Array.from(document.querySelectorAll('meta[name="theme-color"]'));
    const defaults = metas.map(meta => meta.getAttribute('content'));
    const current = () => root.dataset.theme || 'dark';

    function sync() {
      const theme = current();
      const next = theme === 'dark' ? 'light' : 'dark';
      button.setAttribute('aria-label', `Switch to ${next} theme`);
      button.title = `Switch to ${next} theme`;
      const background = getComputedStyle(root).getPropertyValue('--bg').trim();
      metas.forEach((meta, index) => meta.setAttribute('content', root.dataset.theme && background ? background : defaults[index]));
    }

    button.addEventListener('click', () => {
      const next = current() === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem(THEME_KEY, next); } catch { /* storage unavailable: the choice lasts for this page view */ }
      sync();
    });
    sync();
  }

  // Mobile navigation disclosure. The menu follows its button in the DOM, so Tab moves from the
  // button into the links; the menu closes when focus or a click leaves the header.
  function setupNav() {
    const toggle = document.querySelector('.nav-toggle');
    const nav = document.getElementById('site-nav');
    const header = document.querySelector('.site-header');
    if (!toggle || !nav || !header) return;
    const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';
    const setOpen = open => {
      toggle.setAttribute('aria-expanded', String(open));
      header.classList.toggle('nav-open', open);
    };
    toggle.addEventListener('click', () => setOpen(!isOpen()));
    nav.addEventListener('click', event => { if (event.target.closest('a')) setOpen(false); });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && isOpen()) { setOpen(false); toggle.focus(); }
    });
    document.addEventListener('click', event => { if (isOpen() && !header.contains(event.target)) setOpen(false); });
    header.addEventListener('focusout', event => {
      if (isOpen() && event.relatedTarget && !header.contains(event.relatedTarget)) setOpen(false);
    });
    onMediaChange(window.matchMedia('(min-width: 960px)'), event => { if (event.matches) setOpen(false); });
  }

  // Highlights the navigation link of the section in the middle of the viewport.
  function setupNavHighlight() {
    if (!('IntersectionObserver' in window)) return;
    const links = Array.from(document.querySelectorAll('.site-nav a[href^="#"]'));
    const sections = new Map();
    links.forEach(link => {
      const section = document.getElementById(link.getAttribute('href').slice(1));
      if (section) sections.set(section, link);
    });
    if (!sections.size) return;
    const visible = new Set();
    const update = () => {
      let active = null;
      for (const section of sections.keys()) if (visible.has(section)) { active = section; break; }
      links.forEach(link => link.removeAttribute('aria-current'));
      if (active) sections.get(active).setAttribute('aria-current', 'true');
    };
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => { if (entry.isIntersecting) visible.add(entry.target); else visible.delete(entry.target); });
      update();
    }, { rootMargin: '-40% 0px -55% 0px' });
    sections.forEach((_, section) => observer.observe(section));
  }

  // Fades content in as it scrolls into view. Content already on screen is never hidden.
  function setupReveal() {
    if (reduceMotion.matches || !('IntersectionObserver' in window)) return;
    const items = Array.from(document.querySelectorAll('.reveal'));
    const fold = window.innerHeight * 0.92;
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.remove('is-pending');
        entry.target.classList.add('is-revealed');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });
    items.forEach(item => {
      if (item.getBoundingClientRect().top < fold) return;
      item.classList.add('is-pending');
      observer.observe(item);
    });
  }

  // Copy buttons for code blocks, with polite screen reader feedback.
  function copyWithSelection(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    area.remove();
    return copied;
  }

  function setupCopy() {
    document.querySelectorAll('[data-copy]').forEach(button => {
      const block = button.closest('.code-block');
      const code = block && block.querySelector('code');
      const label = button.querySelector('.copy-label');
      if (!code || !label) return;
      let timer = 0;
      button.addEventListener('click', async () => {
        const text = code.textContent.trim();
        let copied = false;
        try {
          await navigator.clipboard.writeText(text);
          copied = true;
        } catch {
          copied = copyWithSelection(text);
          button.focus();
        }
        label.textContent = copied ? 'Copied' : 'Copy failed';
        button.dataset.state = copied ? 'copied' : 'failed';
        announce(copied ? 'Copied to clipboard.' : 'Copy failed. Select the text and copy it manually.');
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          label.textContent = 'Copy';
          delete button.dataset.state;
        }, 2000);
      });
      button.hidden = false;
    });
  }

  setupTheme();
  setupNav();
  root.classList.add('js-ready');
  setupNavHighlight();
  setupReveal();
  setupCopy();
})();

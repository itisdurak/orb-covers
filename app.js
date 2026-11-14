'use strict';

/* ------------------------------------------------------------------ utils */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------ header */

const head = $('#site-head');
const progress = $('#scroll-progress');
let rafPending = false;

function onScroll() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    const y = window.scrollY || document.documentElement.scrollTop;
    head.classList.toggle('is-scrolled', y > 8);

    const max = document.documentElement.scrollHeight - window.innerHeight;
    const ratio = max > 0 ? Math.min(1, Math.max(0, y / max)) : 0;
    progress.style.transform = `scaleX(${ratio})`;
    rafPending = false;
  });
}

window.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('resize', onScroll);
onScroll();

/* ----------------------------------------------------------------- marquee */

const track = $('#marquee-track');
if (track) {
  const clone = track.cloneNode(true);
  $$('img', clone).forEach((img) => {
    img.alt = '';
    img.loading = 'lazy';
  });
  $$('a', clone).forEach((link) => {
    link.setAttribute('aria-hidden', 'true');
    link.tabIndex = -1;
  });
  Array.from(clone.children).forEach((child) => track.appendChild(child));
}

/* ------------------------------------------------------------------ reveal */

if (!reduceMotion) {
  const revealTargets = $$('.section-head, .case__visual, .case__info, .how__card, .files, .codebox');
  revealTargets.forEach((el, i) => {
    el.classList.add('reveal');
    el.style.setProperty('--d', `${Math.min(i % 4, 3) * 70}ms`);
  });

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.08, rootMargin: '0px 0px -6% 0px' }
  );

  revealTargets.forEach((el) => io.observe(el));
}

/* ---------------------------------------------------------------- lightbox */

const lightbox = $('#lightbox');
const lightboxImg = $('#lightbox-img');
const lightboxCap = $('#lightbox-cap');
const lightboxLink = $('#lightbox-link');
const closeBtn = $('.lightbox__close', lightbox);
let lastFocus = null;

function fileLabel(img) {
  const src = img.getAttribute('src') || '';
  const name = src.split('/').pop();
  const caseEl = img.closest('[id^="case-"]');
  const title = caseEl ? ($('.case__title', caseEl)?.textContent || '').trim() : '';
  const w = img.naturalWidth || img.getAttribute('width') || '';
  const h = img.naturalHeight || img.getAttribute('height') || '';
  return `${title ? title + ' · ' : ''}${name}${w && h ? ` · ${w} × ${h}` : ''}`;
}

function openLightbox(img) {
  if (!lightbox || !lightboxImg) return;
  lightboxImg.src = img.currentSrc || img.src;
  lightboxImg.alt = img.alt || '';
  lightboxCap.textContent = fileLabel(img);
  lightboxLink.href = img.currentSrc || img.src;
  lightbox.classList.add('is-open');
  lightbox.setAttribute('aria-hidden', 'false');
  document.body.classList.add('lightbox-open');
  lastFocus = img;
  requestAnimationFrame(() => closeBtn.focus({ preventScroll: true }));
}

function closeLightbox() {
  if (!lightbox || !lightbox.classList.contains('is-open')) return;
  lightbox.classList.remove('is-open');
  lightbox.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('lightbox-open');
  lightboxImg.src = '';
  if (lastFocus) lastFocus.focus({ preventScroll: true });
  lastFocus = null;
}

if (lightbox) {
  $$('.mock img').forEach((img) => {
    img.addEventListener('click', (event) => {
      if (event.target.closest('button, a')) return;
      event.preventDefault();
      openLightbox(img);
    });
  });

  closeBtn.addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', (event) => {
    if (event.target === lightbox) closeLightbox();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeLightbox();
  });
}

/* ------------------------------------------------------------------- copy */

$$('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const text = button.getAttribute('data-copy');
    const original = button.textContent;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      button.textContent = 'Скопировано ✓';
    } catch {
      button.textContent = 'Не вышло :(';
    }
    setTimeout(() => {
      button.textContent = original;
    }, 1800);
  });
});

/* ------------------------------------------------------------------ anchor */

$$('a[href^="#"]').forEach((link) => {
  link.addEventListener('click', (event) => {
    const id = link.getAttribute('href');
    if (!id || id === '#') return;
    const target = document.querySelector(id);
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    history.replaceState(null, '', id);
  });
});

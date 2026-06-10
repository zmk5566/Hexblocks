(function () {
  const deck = window.HEXBLOCKS_DECK || { slides: [], scenes: {} };
  const slidesEl = document.getElementById('slides');
  const stage = document.getElementById('stage');
  const prevBtn = document.getElementById('prev');
  const nextBtn = document.getElementById('next');
  const autoBtn = document.getElementById('auto');
  const narrationAudio = document.getElementById('narration-audio');
  const subtitle = document.getElementById('subtitle');
  const counter = document.getElementById('ctr');
  const nav = document.getElementById('nav');
  const navToggle = document.getElementById('nav-toggle');
  const navDock = document.getElementById('nav-dock');
  const navToggleCounter = document.getElementById('nav-toggle-counter');
  const progress = document.getElementById('prog');

  const DEFAULT_STEP_MS = 3600;
  const DEFAULT_SLIDE_MS = 4600;
  const DEFAULT_AFTER_STEPS_MS = 900;
  const SUBTITLE_FADE_MS = 260;
  const SUBTITLE_BUFFER_MS = 140;
  const NAV_HIDE_MS = 2500;
  const ENTER_STEP_DELAY_MS = 700;

  let current = 0;
  let slides = [];
  let visibleSlidesData = [];
  let autoplay = false;
  let autoTimer = null;
  let activeAudio = null;
  let activeAudioKey = '';
  let subtitleTimer = null;
  let subtitleRun = 0;
  let navTimer = null;
  let enterStepTimer = null;
  let enterStepRun = 0;
  let videoAutoplayCleanup = null;
  const imageSequenceTimers = new WeakMap();

  function escapeHTML(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function slugify(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/<[^>]*>/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 56) || 'caption';
  }

  function isAbsoluteAssetPath(src) {
    return /^(https?:|data:|blob:|\/)/i.test(String(src || ''));
  }

  function joinAssetPath(base, file) {
    if (!file) return '';
    if (isAbsoluteAssetPath(file)) return file;
    if (!base) return file;
    return `${String(base).replace(/\/?$/, '/')}${file}`;
  }

  function hexIcon(fill = 'currentColor') {
    return `<svg viewBox="0 0 10 10" aria-hidden="true"><polygon points="5,0 9.33,2.5 9.33,7.5 5,10 0.67,7.5 0.67,2.5" fill="${fill}"/></svg>`;
  }

  function chip(text) {
    return `<div class="chip reveal">${hexIcon()}${escapeHTML(text || '')}</div>`;
  }

  function renderAuthors(authors) {
    if (!authors || !authors.length) return '';
    return `
      <div class="author-links reveal">
        ${authors.map((author) => `
          <a href="${escapeHTML(author.url || '#')}" target="_blank" rel="noopener noreferrer">${escapeHTML(author.name)}</a>
        `).join('<span aria-hidden="true">/</span>')}
      </div>
    `;
  }

  function renderTable(table) {
    if (!table) return '';
    const headers = (table.headers || []).map((h) => `<th>${escapeHTML(h)}</th>`).join('');
    const rows = (table.rows || []).map((row) => (
      `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`
    )).join('');
    return `<table class="reveal"><tr>${headers}</tr>${rows}</table>`;
  }

  function renderCards(cards) {
    if (!cards) return '';
    return `
      <div class="cards reveal">
        ${cards.map(([title, body, action], i) => `
          <div class="card" data-card-index="${i + 1}">
            <div class="card-title">${hexIcon()}${escapeHTML(title)}</div>
            ${action ? `<div class="card-action">${escapeHTML(action)}</div>` : ''}
            <p>${escapeHTML(body)}</p>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderContinuityChain(parts) {
    if (!parts) return '';
    return `
      <div class="quote continuity-chain">
        ${parts.map((part, i) => `
          ${i ? '<span class="chain-arrow">-&gt;</span>' : ''}
          <span class="chain-part" data-chain-index="${i + 1}">${escapeHTML(part)}</span>
        `).join('')}
      </div>
    `;
  }

  function renderImageTriptych(images) {
    if (!images) return '';
    return `
      <div class="image-triptych reveal" data-staged-triptych>
        ${images.map((image, i) => `
          <figure class="image-panel" data-reveal-step="${i + 1}">
            <img src="${escapeHTML(image.src)}" alt="${escapeHTML(image.alt || '')}">
          </figure>
        `).join('')}
      </div>
    `;
  }

  function renderOverviewFigure(figure) {
    if (!figure) return '';
    return `
      <figure class="overview-figure reveal">
        <img src="${escapeHTML(figure.src)}" alt="${escapeHTML(figure.alt || '')}">
        ${figure.caption ? `<figcaption>${escapeHTML(figure.caption)}</figcaption>` : ''}
      </figure>
    `;
  }

  function renderImageSequence(sequence) {
    if (!sequence) return '';
    const frames = sequence.frames || [];
    const allFrames = sequence.final ? [...frames, sequence.final] : frames;
    return `
      <figure class="overview-figure image-sequence reveal" data-image-sequence data-frame-ms="${escapeHTML(sequence.frameMs || 1000)}" data-sequence-mode="${escapeHTML(sequence.mode || 'replace')}">
        ${allFrames.map((frame, i) => `
          <img class="image-sequence-frame ${i === 0 ? 'is-active' : ''}" src="${escapeHTML(frame.src)}" alt="${escapeHTML(frame.alt || '')}" data-sequence-frame="${i}">
        `).join('')}
        ${sequence.caption ? `<figcaption>${escapeHTML(sequence.caption)}</figcaption>` : ''}
      </figure>
    `;
  }

  function renderVisualImage(image) {
    if (!image) return '';
    return `
      <figure class="visual-image">
        <img src="${escapeHTML(image.src)}" alt="${escapeHTML(image.alt || '')}">
      </figure>
    `;
  }

  function renderFullImage(image) {
    if (!image) return '';
    return `
      <figure class="full-image-figure reveal">
        <img src="${escapeHTML(image.src)}" alt="${escapeHTML(image.alt || '')}">
      </figure>
    `;
  }

  function renderBeats(beats) {
    if (!beats) return '';
    return `
      <div class="beats reveal">
        ${beats.map((beat, i) => `
          <div class="beat">
            <span class="beat-n">${String(i + 1).padStart(2, '0')}</span>
            <span>${beat}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderBullets(slide) {
    const bullets = slide.bullets;
    if (!bullets) return '';
    const stepReveal = slide.bulletsReveal === 'step';
    return `
      <div class="slide-bullet-block ${stepReveal ? '' : 'reveal'}">
        ${slide.bulletHeading ? `<div class="bullet-heading ${stepReveal ? 'controlled-reveal' : ''}"${stepReveal ? ' data-bullet-heading' : ''}>${escapeHTML(slide.bulletHeading)}</div>` : ''}
        <ul class="slide-bullets">
          ${bullets.map((bullet, i) => `<li class="${stepReveal ? 'controlled-reveal' : ''}" data-bullet-index="${i + 1}">${escapeHTML(bullet)}</li>`).join('')}
        </ul>
      </div>
    `;
  }

  function renderModeCards(modes) {
    if (!modes) return '';
    return `
      <div class="mode-cards reveal">
        ${modes.map((mode, i) => `
          <section class="mode-card" data-mode-card="${i + 1}">
            <div class="mode-card-kicker">${escapeHTML(mode.kicker || '')}</div>
            <h3>${escapeHTML(mode.title || '')}</h3>
            ${mode.subtitle ? `<div class="mode-card-subtitle">${escapeHTML(mode.subtitle)}</div>` : ''}
            <p>${escapeHTML(mode.body || '')}</p>
            ${mode.flow ? `<div class="mode-card-flow">${escapeHTML(mode.flow)}</div>` : ''}
            <div class="mode-card-image-slot">
              ${mode.image ? `
                <img src="${escapeHTML(mode.image.src)}" alt="${escapeHTML(mode.image.alt || '')}">
              ` : escapeHTML(mode.imageSlot || 'image slot')}
            </div>
          </section>
        `).join('')}
      </div>
    `;
  }

  function renderClosing(closing) {
    if (!closing) return '';
    const moduleTypes = closing.moduleTypes || [];
    const moduleMarquee = moduleTypes.length ? `
      <div class="closing-marquee" aria-hidden="true">
        <div class="module-marquee-track">
          ${[0, 1].map(() => `
            <div class="module-marquee-set">
              ${moduleTypes.map((moduleType) => `
                <span class="module-type-chip" style="--module-color: ${escapeHTML(moduleType.color || '#989898')}">
                  <span class="module-type-mark"></span>
                  ${escapeHTML(moduleType.label)}
                </span>
              `).join('')}
            </div>
          `).join('')}
        </div>
      </div>
    ` : '';
    return `
      <div class="closing-card reveal">
        <p class="lead">${escapeHTML(closing.intro)}</p>
        <div class="repo">${escapeHTML(closing.repo)}</div>
        <div class="tags">
          ${(closing.tags || []).map((tag) => `<span class="tag">${escapeHTML(tag)}</span>`).join('')}
        </div>
        ${moduleMarquee}
      </div>
    `;
  }

  function renderReferences(refs) {
    if (!refs) return '';
    return `
      <div class="refs reveal">
        ${refs.map(([, body], i) => `
          <div class="ref-entry">
            <span class="ref-key">[${i + 1}]</span>
            <span class="ref-body">${body}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderReferenceMarquee(marquee) {
    if (!marquee) return '';
    const modules = marquee.modules || [];
    const message = marquee.message || 'THANKS FOR WATCHING';
    const sequence = [
      ...modules.slice(0, 2),
      { message },
      ...modules.slice(2, 4),
      { message },
      ...modules.slice(4),
      { message }
    ];
    return `
      <div class="reference-marquee" aria-hidden="true">
        <div class="reference-marquee-track">
          ${[0, 1].map(() => `
            <div class="reference-marquee-set">
              ${sequence.map((item) => item.message ? `
                <span class="reference-thanks">${escapeHTML(item.message)}</span>
              ` : `
                <span class="reference-hexblock" style="--module-color: ${escapeHTML(item.color || '#989898')}">
                  <span class="reference-hex-shape"></span>
                  <span class="reference-hex-label">${escapeHTML(item.label || '')}</span>
                </span>
              `).join('')}
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderVideo(video) {
    if (!video) return '';
    const frameClasses = [
      'video-frame',
      video.placeholder || !video.src ? 'video-placeholder' : ''
    ].filter(Boolean).join(' ');
    if (video.placeholder || !video.src) {
      return `
        <div class="${frameClasses} reveal">
          <div class="video-placeholder-inner">
            <div class="video-play-mark" aria-hidden="true"></div>
            <div class="video-placeholder-title">${escapeHTML(video.label || 'Video placeholder')}</div>
            ${video.meta ? `<div class="video-placeholder-meta">${escapeHTML(video.meta)}</div>` : ''}
          </div>
        </div>
      `;
    }
    const attrs = [
      'playsinline',
      video.muted !== false ? 'muted' : '',
      video.loop ? 'loop' : '',
      video.autoplay ? 'data-autoplay="true"' : '',
      video.resetOnLeave !== false ? 'data-reset-on-leave="true"' : ''
    ].filter(Boolean).join(' ');
    const poster = video.poster ? ` poster="${escapeHTML(video.poster)}"` : '';
    const controls = video.controls ? `
      <div class="video-controls" data-video-controls>
        <button class="video-play-toggle" type="button" data-video-play>Play</button>
        <input class="video-seek" type="range" min="0" max="1000" value="0" step="1" data-video-seek aria-label="Video progress">
        <span class="video-time" data-video-time>0:00 / 0:00</span>
      </div>
    ` : '';
    return `
      <div class="${frameClasses} reveal">
        <div class="video-media">
          <video src="${escapeHTML(video.src)}"${poster} ${attrs}></video>
        </div>
        ${controls}
      </div>
    `;
  }

  function renderSceneStack(sceneStack) {
    if (!sceneStack) return '';
    return `
      <div class="demo-scene-stack">
        ${sceneStack.map((item, i) => `
          <section class="demo-scene-strip demo-scene-${escapeHTML(item.tone || 'default')}">
            <div class="mini-scene-title">
              <span>${String(i + 1).padStart(2, '0')}</span>
              ${escapeHTML(item.label || '')}
            </div>
            <div class="mini-scene-stage" data-scene-stage="${escapeHTML(item.scene)}"></div>
          </section>
        `).join('')}
      </div>
    `;
  }

  function renderSlide(slide, index) {
    const hasScene = Boolean(slide.scene || slide.sceneStack);
    const hasVisual = Boolean(hasScene || slide.visualImage);
    const classes = [
      'slide',
      slide.slug || '',
      hasVisual ? 'with-scene' : 'no-scene',
      slide.sceneStack ? 'with-scene-stack' : '',
      slide.video ? 'video-slide' : '',
      slide.imageTriptych ? 'image-slide' : '',
      slide.fullImage ? 'full-image-slide' : '',
      slide.overviewFigure || slide.imageSequence ? 'overview-slide' : '',
      slide.references ? 'references' : '',
      slide.slug === 'related-work' ? 'related-work' : ''
    ].filter(Boolean).join(' ');

    const visual = hasVisual ? `
      <aside class="visual-shell reveal" aria-hidden="true">
        ${slide.visualImage ? renderVisualImage(slide.visualImage) : ''}
        ${!slide.visualImage && slide.sceneStack ? renderSceneStack(slide.sceneStack) : ''}
        ${!slide.visualImage && !slide.sceneStack ? `<div data-scene-stage="${escapeHTML(slide.scene)}"></div>` : ''}
      </aside>
    ` : '';

    const defAttrs = slide.defReveal ? ` data-action-reveal="${escapeHTML(slide.defReveal)}"` : '';
    const defClass = slide.defReveal ? 'def reveal controlled-reveal' : 'def reveal';
    const headingTag = index === 0 ? 'h1' : 'h2';
    const titleClass = slide.titleReveal === 'step' ? 'controlled-reveal' : 'reveal';
    const titleAttrs = slide.titleReveal === 'step' ? ' data-step-title' : '';
    const leadClass = slide.leadReveal === 'step' ? 'lead controlled-reveal' : 'lead reveal';
    const leadAttrs = slide.leadReveal === 'step' ? ' data-step-lead' : '';
    const copy = `
      <section class="slide-copy">
        ${slide.chip ? chip(slide.chip) : ''}
        ${slide.title ? `<${headingTag} class="${titleClass}"${titleAttrs}>${escapeHTML(slide.title)}</${headingTag}>` : ''}
        ${renderAuthors(slide.authors)}
        ${slide.sub ? `<div class="sub reveal">${escapeHTML(slide.sub)}</div>` : ''}
        ${slide.lead ? `<p class="${leadClass}"${leadAttrs}>${slide.lead}</p>` : ''}
        ${slide.def ? `<div class="${defClass}"${defAttrs}>${escapeHTML(slide.def)}</div>` : ''}
        ${renderTable(slide.table)}
        ${renderCards(slide.cards)}
        ${renderImageTriptych(slide.imageTriptych)}
        ${renderFullImage(slide.fullImage)}
        ${renderOverviewFigure(slide.overviewFigure)}
        ${renderImageSequence(slide.imageSequence)}
        ${renderBullets(slide)}
        ${renderBeats(slide.beats)}
        ${renderModeCards(slide.modeCards)}
        ${renderContinuityChain(slide.quoteParts)}
        ${slide.quote ? `<div class="quote reveal">${slide.quote}</div>` : ''}
        ${slide.proof ? `<div class="proof reveal">${slide.proof}</div>` : ''}
        ${renderClosing(slide.closing)}
        ${renderVideo(slide.video)}
        ${renderReferences(slide.references)}
        ${renderReferenceMarquee(slide.referenceMarquee)}
      </section>
    `;

    return `
      <article class="${classes}" data-slide="${index}" data-slug="${escapeHTML(slide.slug || `slide-${index}`)}">
        <div class="slide-layout">
          ${copy}
          ${visual}
        </div>
      </article>
    `;
  }

  function renderDeck() {
    visibleSlidesData = deck.slides.filter((slide) => !slide.hidden);
    slidesEl.innerHTML = visibleSlidesData.map(renderSlide).join('');
    slides = Array.from(slidesEl.querySelectorAll('.slide'));
    window.HexScene.mountAll(slidesEl, deck.scenes);
  }

  function resize() {
    const scale = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
    stage.style.transform = `scale(${scale})`;
  }

  function pauseMedia(slide) {
    if (!slide) return;
    slide.querySelectorAll('video').forEach((video) => {
      video.pause();
      if (video.dataset.resetOnLeave === 'true') {
        try { video.currentTime = 0; } catch (_) {}
      }
    });
  }

  function playMedia(slide) {
    if (!slide) return;
    slide.querySelectorAll('video[data-autoplay="true"]').forEach((video) => {
      const result = video.play();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    });
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return '0:00';
    const total = Math.max(0, Math.floor(seconds));
    const mins = Math.floor(total / 60);
    const secs = String(total % 60).padStart(2, '0');
    return `${mins}:${secs}`;
  }

  function findVideoCaptionIndex(captions, time, options = {}) {
    return captions.findIndex((caption, index) => {
      const start = Number(caption.start ?? 0);
      const nextCaption = captions[index + 1];
      const nextStart = nextCaption ? Number(nextCaption.start ?? Infinity) : Infinity;
      const fallbackDuration = Number(caption.durationMs ?? DEFAULT_STEP_MS) / 1000;
      const end = options.useAudioTiming ? nextStart : Number(caption.end ?? (start + fallbackDuration));
      return time >= start && time < end;
    });
  }

  function playAudioSource(src, key, options = {}) {
    const scheduleNext = options.scheduleNext !== false;
    if (!narrationAudio?.checked || !src) {
      stopActiveAudio();
      if (scheduleNext && options.fallbackMs) scheduleAutoplay(options.fallbackMs);
      return;
    }
    if (activeAudio && activeAudioKey === key) return;
    stopActiveAudio();
    activeAudio = new Audio(src);
    activeAudioKey = key;
    if (scheduleNext) {
      activeAudio.addEventListener('ended', () => scheduleAutoplay(options.afterMs ?? 350), { once: true });
      activeAudio.addEventListener('error', () => scheduleAutoplay(options.fallbackMs || DEFAULT_STEP_MS), { once: true });
    } else {
      activeAudio.addEventListener('ended', () => {
        if (activeAudioKey === key && typeof options.onEnded === 'function') options.onEnded(key);
      }, { once: true });
      activeAudio.addEventListener('error', () => {
        if (activeAudioKey === key && typeof options.onError === 'function') options.onError(key);
      }, { once: true });
    }
    const result = activeAudio.play();
    if (result && typeof result.catch === 'function') {
      result.catch(() => {
        if (scheduleNext) scheduleAutoplay(options.fallbackMs || DEFAULT_STEP_MS);
      });
    }
  }

  function syncVideoCaptions(slide) {
    if (!slide || slide !== slides[current]) return;
    const slideIndex = Number(slide.dataset.slide || current);
    const captions = getSlideData(slideIndex).videoCaptions || [];
    if (!captions.length) return;
    const video = slide.querySelector('video');
    if (!video) return;

    const useAudioTiming = captions.some((caption, index) => resolveCueAudio(caption, 'videoCaption', slideIndex, index));
    const activeCaptionIndex = findVideoCaptionIndex(captions, video.currentTime || 0, { useAudioTiming });
    const activeCaption = activeCaptionIndex >= 0 ? captions[activeCaptionIndex] : null;
    const nextText = activeCaption?.text || '';
    const nextKey = activeCaption ? `${slideIndex}:video:${activeCaptionIndex}` : '';
    if (!activeCaption) {
      if (slide.dataset.activeVideoCaption !== nextKey) {
        slide.dataset.activeVideoCaption = nextKey;
        setSubtitle(nextText);
      }
      stopActiveAudio();
      return;
    }
    if (slide.dataset.activeVideoCaption !== nextKey) {
      slide.dataset.activeVideoCaption = nextKey;
      setSubtitle(nextText);
    }
    if (video.paused || video.ended) {
      stopActiveAudio();
      return;
    }
    playAudioSource(
      resolveCueAudio(activeCaption, 'videoCaption', slideIndex, activeCaptionIndex),
      nextKey,
      {
        scheduleNext: false,
        onEnded: (endedKey) => {
          if (slides[current] !== slide || slide.dataset.activeVideoCaption !== endedKey) return;
          setSubtitle('');
        },
        onError: (errorKey) => {
          if (slides[current] !== slide || slide.dataset.activeVideoCaption !== errorKey) return;
          setSubtitle(nextText);
        }
      }
    );
  }

  function setupVideoControls() {
    slidesEl.querySelectorAll('[data-video-controls]').forEach((controls) => {
      const frame = controls.closest('.video-frame');
      const slide = frame?.closest('.slide');
      const video = frame?.querySelector('video');
      const media = frame?.querySelector('.video-media');
      const play = controls.querySelector('[data-video-play]');
      const seek = controls.querySelector('[data-video-seek]');
      const time = controls.querySelector('[data-video-time]');
      if (!frame || !video || !media || !play || !seek || !time) return;
      let hideTimer = null;

      const clearHideTimer = () => {
        if (!hideTimer) return;
        window.clearTimeout(hideTimer);
        hideTimer = null;
      };

      const scheduleControlsHide = () => {
        clearHideTimer();
        if (video.paused) return;
        hideTimer = window.setTimeout(() => {
          frame.classList.remove('is-interacting');
        }, 950);
      };

      const showControlsBriefly = () => {
        frame.classList.add('is-interacting');
        scheduleControlsHide();
      };

      const sync = () => {
        const duration = video.duration || 0;
        seek.value = duration ? String(Math.round((video.currentTime / duration) * 1000)) : '0';
        play.textContent = video.paused ? 'Play' : 'Pause';
        time.textContent = `${formatTime(video.currentTime)} / ${formatTime(duration)}`;
        frame.classList.toggle('is-playing', !video.paused);
        syncVideoCaptions(slide);
        if (video.paused) {
          clearHideTimer();
          frame.classList.add('is-interacting');
        }
      };

      const togglePlay = () => {
        if (video.paused) {
          const result = video.play();
          if (result && typeof result.catch === 'function') result.catch(() => {});
        } else {
          video.pause();
        }
      };

      play.addEventListener('click', togglePlay);
      media.addEventListener('click', togglePlay);
      frame.addEventListener('pointermove', showControlsBriefly);
      frame.addEventListener('pointerenter', showControlsBriefly);
      frame.addEventListener('focusin', showControlsBriefly);
      seek.addEventListener('input', () => {
        if (!video.duration) return;
        showControlsBriefly();
        video.currentTime = (Number(seek.value) / 1000) * video.duration;
      });
      video.addEventListener('loadedmetadata', sync);
      video.addEventListener('timeupdate', sync);
      video.addEventListener('seeked', () => {
        if (slide) delete slide.dataset.activeVideoCaption;
        stopActiveAudio();
        sync();
      });
      video.addEventListener('play', () => {
        sync();
        showControlsBriefly();
      });
      video.addEventListener('pause', sync);
      video.addEventListener('ended', sync);
      sync();
    });
  }

  function resetStagedTriptychs(slide) {
    if (!slide) return;
    slide.querySelectorAll('[data-staged-triptych]').forEach((triptych) => {
      triptych.dataset.revealed = '0';
      triptych.querySelectorAll('[data-reveal-step]').forEach((panel) => {
        panel.classList.remove('is-visible');
      });
    });
  }

  function resetModeCards(slide) {
    if (!slide) return;
    slide.querySelectorAll('[data-mode-card]').forEach((card) => {
      card.classList.remove('is-visible');
    });
  }

  function resetControlledReveals(slide) {
    if (!slide) return;
    slide.querySelectorAll('[data-action-reveal]').forEach((el) => {
      el.classList.remove('is-visible');
    });
  }

  function clearImageSequence(sequence) {
    const timers = imageSequenceTimers.get(sequence) || [];
    timers.forEach((timer) => window.clearTimeout(timer));
    imageSequenceTimers.delete(sequence);
  }

  function setImageSequenceFrame(sequence, index) {
    sequence.querySelectorAll('[data-sequence-frame]').forEach((frame) => {
      frame.classList.toggle('is-active', Number(frame.dataset.sequenceFrame) === index);
    });
  }

  function revealImageSequenceFrame(sequence, index) {
    const frame = sequence.querySelector(`[data-sequence-frame="${index}"]`);
    if (frame) frame.classList.add('is-active');
  }

  function resetImageSequences(slide) {
    if (!slide) return;
    slide.querySelectorAll('[data-image-sequence]').forEach((sequence) => {
      clearImageSequence(sequence);
      setImageSequenceFrame(sequence, 0);
    });
  }

  function getSlideData(index = current) {
    return visibleSlidesData[index] || {};
  }

  function getSteps(index = current) {
    const slide = getSlideData(index);
    return slide.narration || slide.steps || [];
  }

  function getCueAudioFile(type, slideIndex, cueIndex) {
    const slide = getSlideData(slideIndex);
    const slideNo = String(slideIndex + 1).padStart(2, '0');
    const slideSlug = slugify(slide.slug || slide.title || `slide-${slideNo}`);
    const cueNo = String(cueIndex + 1).padStart(2, '0');
    const cueType = type === 'videoCaption' ? 'video' : 'narration';
    return `${slideNo}-${slideSlug}-${cueType}-${cueNo}.mp3`;
  }

  function resolveCueAudio(cue, type, slideIndex, cueIndex) {
    const file = cue?.audio || (deck.audioBase ? getCueAudioFile(type, slideIndex, cueIndex) : '');
    return joinAssetPath(deck.audioBase || '', file);
  }

  function stopActiveAudio() {
    if (!activeAudio) {
      activeAudioKey = '';
      return;
    }
    activeAudio.pause();
    activeAudio.removeAttribute('src');
    activeAudio = null;
    activeAudioKey = '';
  }

  function clearAutoTimer() {
    if (!autoTimer) return;
    window.clearTimeout(autoTimer);
    autoTimer = null;
  }

  function clearSubtitleTimer() {
    if (!subtitleTimer) return;
    window.clearTimeout(subtitleTimer);
    subtitleTimer = null;
  }

  function clearEnterStepTimer() {
    if (!enterStepTimer) return;
    window.clearTimeout(enterStepTimer);
    enterStepTimer = null;
  }

  function clearVideoAutoplayAdvance() {
    if (!videoAutoplayCleanup) return;
    videoAutoplayCleanup();
    videoAutoplayCleanup = null;
  }

  function clearNavTimer() {
    if (!navTimer) return;
    window.clearTimeout(navTimer);
    navTimer = null;
  }

  function isNavOpen() {
    return Boolean(nav?.classList.contains('is-open'));
  }

  function setNavOpen(open, autoHide = true) {
    if (!nav) return;
    clearNavTimer();
    nav.classList.toggle('is-open', open);
    if (navToggle) {
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      navToggle.setAttribute('title', open ? 'Hide controls' : 'Show controls');
    }
    if (navDock) navDock.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open && autoHide) scheduleNavHide();
  }

  function scheduleNavHide() {
    if (!isNavOpen()) return;
    clearNavTimer();
    navTimer = window.setTimeout(() => {
      if (!isNavOpen()) return;
      const focusedInside = navDock?.contains(document.activeElement);
      if (navDock?.matches(':hover') || focusedInside) {
        scheduleNavHide();
        return;
      }
      setNavOpen(false, false);
    }, NAV_HIDE_MS);
  }

  function setSubtitle(text, options = {}) {
    if (!subtitle) return;
    clearSubtitleTimer();
    subtitleRun += 1;

    const run = subtitleRun;
    const nextText = String(text || '');

    if (options.immediate) {
      subtitle.classList.remove('is-visible', 'is-exiting');
      subtitle.textContent = nextText;
      subtitle.setAttribute('aria-hidden', nextText ? 'false' : 'true');
      if (nextText) {
        void subtitle.offsetWidth;
        window.requestAnimationFrame(() => {
          if (run === subtitleRun) subtitle.classList.add('is-visible');
        });
      }
      return;
    }

    const wasVisible = subtitle.classList.contains('is-visible') && subtitle.textContent;

    const fadeInNext = () => {
      if (run !== subtitleRun) return;
      subtitle.classList.remove('is-visible', 'is-exiting');
      if (!nextText) {
        subtitle.textContent = '';
        subtitle.setAttribute('aria-hidden', 'true');
        return;
      }
      subtitle.textContent = nextText;
      subtitle.setAttribute('aria-hidden', 'false');
      void subtitle.offsetWidth;
      window.requestAnimationFrame(() => {
        if (run === subtitleRun) subtitle.classList.add('is-visible');
      });
    };

    if (wasVisible) {
      subtitle.classList.remove('is-visible');
      subtitle.classList.add('is-exiting');
      subtitleTimer = window.setTimeout(fadeInNext, SUBTITLE_FADE_MS + SUBTITLE_BUFFER_MS);
      return;
    }

    subtitle.classList.remove('is-visible', 'is-exiting');
    if (!nextText) {
      subtitle.textContent = '';
      subtitle.setAttribute('aria-hidden', 'true');
      return;
    }
    subtitleTimer = window.setTimeout(fadeInNext, SUBTITLE_BUFFER_MS);
  }

  function resetSlideSteps(slide) {
    if (!slide) return;
    slide.dataset.stepIndex = '0';
    delete slide.dataset.stepState;
    delete slide.dataset.activeVideoCaption;
    resetControlledReveals(slide);
    resetStagedTriptychs(slide);
    resetModeCards(slide);
    resetImageSequences(slide);
  }

  function performAction(slide, action) {
    if (!slide || !action) return;
    if (action.type === 'setSlideState') {
      slide.dataset.stepState = action.state || '';
    }
    if (action.type === 'clearSlideState') {
      delete slide.dataset.stepState;
    }
    if (action.type === 'pauseScene') {
      slide.querySelectorAll(action.selector || '[data-scene-stage]').forEach((el) => {
        window.HexScene.pause(el);
      });
    }
    if (action.type === 'restartScene') {
      slide.querySelectorAll(action.selector || '[data-scene-stage]').forEach((el) => {
        window.HexScene.reset(el);
        window.HexScene.play(el);
      });
    }
    if (action.type === 'reveal') {
      slide.querySelectorAll(action.selector || '').forEach((el) => {
        el.classList.add(action.className || 'is-visible');
      });
    }
    if (action.type === 'addClass') {
      slide.querySelectorAll(action.selector || '').forEach((el) => {
        el.classList.add(action.className);
      });
    }
    if (action.type === 'removeClass') {
      slide.querySelectorAll(action.selector || '').forEach((el) => {
        el.classList.remove(action.className);
      });
    }
    if (action.type === 'playImageSequence') {
      slide.querySelectorAll(action.selector || '[data-image-sequence]').forEach((sequence) => {
        clearImageSequence(sequence);
        const frames = Array.from(sequence.querySelectorAll('[data-sequence-frame]'));
        const frameMs = action.frameMs || Number(sequence.dataset.frameMs || '1000') || 1000;
        const stacked = action.mode === 'stack' || sequence.dataset.sequenceMode === 'stack';
        setImageSequenceFrame(sequence, 0);
        const timers = frames.slice(1).map((_, i) => window.setTimeout(() => {
          if (stacked) {
            revealImageSequenceFrame(sequence, i + 1);
          } else {
            setImageSequenceFrame(sequence, i + 1);
          }
        }, frameMs * (i + 1)));
        imageSequenceTimers.set(sequence, timers);
      });
    }
  }

  function performStep(slide, step) {
    setSubtitle(step.text || '');
    const actions = step.actions || (step.action ? [step.action] : []);
    actions.forEach((action) => performAction(slide, action));
  }

  function advanceStep(slide = slides[current]) {
    if (!slide) return null;
    const steps = getSteps(current);
    const stepIndex = Number(slide.dataset.stepIndex || '0');
    const step = steps[stepIndex];
    if (!step) return null;
    performStep(slide, step);
    slide.dataset.stepIndex = String(stepIndex + 1);
    return step;
  }

  function scheduleEnterStep(slide, index = current) {
    const slideData = getSlideData(index);
    if (!slideData.onEnterStep || Number(slide?.dataset.stepIndex || '0') !== 0) return false;
    clearEnterStepTimer();
    enterStepRun += 1;
    const run = enterStepRun;
    const delay = slideData.enterStepDelayMs ?? ENTER_STEP_DELAY_MS;
    enterStepTimer = window.setTimeout(() => {
      enterStepTimer = null;
      if (run !== enterStepRun || current !== index || slides[current] !== slide) return;
      if (Number(slide.dataset.stepIndex || '0') !== 0) return;
      const step = advanceStep(slide);
      if (step) playStepAudio(step, step.durationMs || DEFAULT_STEP_MS, { scheduleNext: autoplay });
    }, delay);
    return true;
  }

  function stopAutoplay() {
    autoplay = false;
    clearAutoTimer();
    clearVideoAutoplayAdvance();
    stopActiveAudio();
    if (autoBtn) {
      autoBtn.setAttribute('aria-pressed', 'false');
      autoBtn.classList.remove('is-active');
    }
  }

  function scheduleAutoplay(delay, callback) {
    clearAutoTimer();
    autoTimer = window.setTimeout(callback || runAutoplayStep, delay);
  }

  function playStepAudio(step, fallbackMs, options = {}) {
    const activeSlide = slides[current];
    const stepIndex = Math.max(0, Number(activeSlide?.dataset.stepIndex || '1') - 1);
    playAudioSource(
      resolveCueAudio(step, 'narration', current, stepIndex),
      `${current}:narration:${stepIndex}`,
      {
        fallbackMs,
        afterMs: step.afterMs ?? 350,
        scheduleNext: options.scheduleNext !== false
      }
    );
  }

  function advanceAutoplaySlide() {
    if (!autoplay) return;
    if (current >= slides.length - 1) {
      stopAutoplay();
      return;
    }
    const enterScheduled = show(current + 1);
    if (!enterScheduled) scheduleAutoplay(450);
  }

  function getVideoCaptionFallbackMs(slideData) {
    const captions = slideData.videoCaptions || [];
    const captionEndMs = captions.reduce((maxMs, caption) => {
      const startMs = Number(caption.start ?? 0) * 1000;
      const durationMs = Number(caption.durationMs ?? DEFAULT_STEP_MS);
      return Math.max(maxMs, startMs + durationMs);
    }, 0);
    return Math.max(captionEndMs + 1200, DEFAULT_SLIDE_MS);
  }

  function getVideoAutoplayDelayMs(slideData, video) {
    if (slideData.autoDurationMs) return slideData.autoDurationMs;
    if (Number.isFinite(video.duration) && video.duration > 0) {
      const remainingMs = Math.max(0, (video.duration - (video.currentTime || 0)) * 1000);
      return Math.max(remainingMs + 800, 800);
    }
    return getVideoCaptionFallbackMs(slideData);
  }

  function scheduleVideoAutoplayAdvance(slide) {
    const slideData = getSlideData(current);
    if (!slideData.video) return false;
    const video = slide?.querySelector('video');
    if (!video) return false;
    clearVideoAutoplayAdvance();

    const slideIndex = current;
    let settled = false;

    const cleanup = () => {
      video.removeEventListener('ended', advance);
      video.removeEventListener('error', advance);
      video.removeEventListener('abort', advance);
      video.removeEventListener('loadedmetadata', armFallback);
      if (videoAutoplayCleanup === cleanup) videoAutoplayCleanup = null;
    };

    const advance = () => {
      if (settled) return;
      settled = true;
      cleanup();
      clearAutoTimer();
      if (!autoplay || current !== slideIndex || slides[current] !== slide) return;
      advanceAutoplaySlide();
    };

    const armFallback = () => {
      if (settled || current !== slideIndex || slides[current] !== slide) return;
      scheduleAutoplay(getVideoAutoplayDelayMs(slideData, video), advance);
    };

    video.addEventListener('ended', advance, { once: true });
    video.addEventListener('error', advance, { once: true });
    video.addEventListener('abort', advance, { once: true });

    if (video.ended) {
      scheduleAutoplay(250, advance);
    } else if (Number.isFinite(video.duration) && video.duration > 0) {
      armFallback();
    } else {
      video.addEventListener('loadedmetadata', armFallback, { once: true });
      scheduleAutoplay(getVideoCaptionFallbackMs(slideData), advance);
    }
    videoAutoplayCleanup = cleanup;
    return true;
  }

  function runAutoplayStep() {
    if (!autoplay) return;
    const activeSlide = slides[current];
    const step = advanceStep(activeSlide);
    if (step) {
      playStepAudio(step, step.durationMs || DEFAULT_STEP_MS);
      return;
    }

    const steps = getSteps(current);
    const completedSteppedSlide = steps.length && Number(activeSlide?.dataset.stepIndex || '0') >= steps.length;
    if (!completedSteppedSlide && scheduleVideoAutoplayAdvance(activeSlide)) return;
    const delay = completedSteppedSlide
      ? (getSlideData(current).afterStepsMs || DEFAULT_AFTER_STEPS_MS)
      : (getSlideData(current).autoDurationMs || DEFAULT_SLIDE_MS);
    scheduleAutoplay(delay, advanceAutoplaySlide);
  }

  function startAutoplay() {
    autoplay = true;
    if (autoBtn) {
      autoBtn.setAttribute('aria-pressed', 'true');
      autoBtn.classList.add('is-active');
    }
    if (scheduleEnterStep(slides[current], current)) return;
    scheduleAutoplay(250);
  }

  function toggleAutoplay() {
    if (autoplay) {
      stopAutoplay();
    } else {
      startAutoplay();
    }
  }

  function advanceAction(options = {}) {
    if (options.manual && autoplay) stopAutoplay();
    clearEnterStepTimer();
    const step = advanceStep(slides[current]);
    if (step) {
      if (options.manual) playStepAudio(step, step.durationMs || DEFAULT_STEP_MS, { scheduleNext: false });
      return;
    }
    go(1);
  }

  function show(index) {
    if (!slides.length) return;
    clearEnterStepTimer();
    const nextIndex = Math.max(0, Math.min(slides.length - 1, index));
    const previousSlide = slides[current];
    const nextSlide = slides[nextIndex];

    if (previousSlide && previousSlide !== nextSlide) {
      previousSlide.classList.remove('active');
      clearVideoAutoplayAdvance();
      pauseMedia(previousSlide);
      stopActiveAudio();
      resetSlideSteps(previousSlide);
    }

    window.HexScene.pauseAll(slidesEl);
    current = nextIndex;
    nextSlide.classList.add('active');
    if (!nextSlide.dataset.stepIndex) nextSlide.dataset.stepIndex = '0';
    setSubtitle('', { immediate: true });

    nextSlide.querySelectorAll('[data-scene-stage]').forEach((el) => window.HexScene.play(el));
    playMedia(nextSlide);
    syncVideoCaptions(nextSlide);
    const enterScheduled = scheduleEnterStep(nextSlide, nextIndex);

    const slideCounter = `${String(current + 1).padStart(2, '0')} / ${String(slides.length).padStart(2, '0')}`;
    counter.textContent = slideCounter;
    if (navToggleCounter) navToggleCounter.textContent = slideCounter;
    prevBtn.disabled = current === 0;
    nextBtn.disabled = current === slides.length - 1;
    progress.style.width = `${((current + 1) / slides.length) * 100}%`;
    return enterScheduled;
  }

  function go(delta) {
    show(current + delta);
  }

  function onKeydown(event) {
    if (event.target.closest('button, input, textarea, select, video')) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === ' ') {
      event.preventDefault();
      advanceAction({ manual: true });
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (autoplay) stopAutoplay();
      go(-1);
    }
  }

  function onSlideClick(event) {
    if (event.target.closest('button, a, video, input, textarea, select, [data-nav-control]')) return;
    advanceAction({ manual: true });
  }

  renderDeck();
  setupVideoControls();
  resize();
  show(0);

  window.addEventListener('resize', resize);
  document.addEventListener('keydown', onKeydown);
  slidesEl.addEventListener('click', onSlideClick);
  prevBtn.addEventListener('click', () => {
    if (autoplay) stopAutoplay();
    go(-1);
    scheduleNavHide();
  });
  nextBtn.addEventListener('click', () => {
    advanceAction({ manual: true });
    scheduleNavHide();
  });
  if (autoBtn) {
    autoBtn.addEventListener('click', () => {
      toggleAutoplay();
      scheduleNavHide();
    });
  }
  if (narrationAudio) {
    narrationAudio.addEventListener('change', () => {
      if (!narrationAudio.checked) {
        stopActiveAudio();
        return;
      }
      syncVideoCaptions(slides[current]);
    });
  }
  if (navToggle) {
    navToggle.addEventListener('click', () => setNavOpen(!isNavOpen()));
  }
  if (nav) {
    nav.addEventListener('click', (event) => {
      if (event.target.closest('.nav-dock button, .audio-toggle')) scheduleNavHide();
    });
  }
  if (navDock) {
    navDock.addEventListener('mouseenter', clearNavTimer);
    navDock.addEventListener('mouseleave', scheduleNavHide);
    navDock.addEventListener('focusin', clearNavTimer);
    navDock.addEventListener('focusout', scheduleNavHide);
  }
  window.go = go;
})();

(function() {
    const STORAGE_KEY = 'vivash-theme';
    const themeToggle = document.getElementById('theme-toggle');
    const sunIcon = themeToggle?.querySelector('.theme-icon-sun');
    const moonIcon = themeToggle?.querySelector('.theme-icon-moon');

    const themes = {
        dark: { css: 'css/dark.css', js: 'js/dark.js', icon: 'dark' },
        light: { css: 'css/white.css', js: 'js/white.js', icon: 'light' }
    };

    // On first visit, detect system preference. On return visits, use saved preference.
    const savedTheme = localStorage.getItem(STORAGE_KEY);
    const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    let currentTheme = savedTheme || (systemPrefersDark ? 'dark' : 'light');
    let loadedCSS = null;
    let loadedJS = null;

    function setThemeIcon(theme) {
        if (!sunIcon || !moonIcon) return;
        if (theme === 'dark') {
            sunIcon.classList.add('hidden');
            moonIcon.classList.remove('hidden');
        } else {
            sunIcon.classList.remove('hidden');
            moonIcon.classList.add('hidden');
        }
    }

    // Transition overlay — prevents flash of unstyled content on theme switch
    let overlay = null;
    function showOverlay() {
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;background:#000;z-index:99998;opacity:0;transition:opacity 0.2s ease;pointer-events:none;';
            document.body.appendChild(overlay);
        }
        overlay.style.opacity = '1';
        overlay.style.pointerEvents = 'all';
    }
    function hideOverlay() {
        if (!overlay) return;
        overlay.style.opacity = '0';
        overlay.style.pointerEvents = 'none';
    }

    function loadTheme(themeName) {
        const theme = themes[themeName];
        if (!theme) return;

        const isSwitch = !!(loadedCSS); // true if switching, false if initial load

        // Show overlay instantly before anything unloads
        if (isSwitch) showOverlay();

        // Remove previous CSS/JS and call destroy
        if (loadedJS && window.__currentTheme?.destroy) {
            window.__currentTheme.destroy();
        }
        if (loadedCSS) loadedCSS.remove();
        if (loadedJS) loadedJS.remove();

        window.__currentTheme = null;

        // Load new CSS
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = theme.css;
        document.head.appendChild(link);
        loadedCSS = link;

        // Load new JS — wait for CSS to load first
        link.addEventListener('load', () => {
            const script = document.createElement('script');
            script.src = theme.js;
            script.onload = () => {
                if (window.__currentTheme?.init) {
                    window.__currentTheme.init();
                }
                document.dispatchEvent(new Event('theme-ready'));
                // Hide overlay after theme fully painted
                if (isSwitch) setTimeout(hideOverlay, 80);
            };
            document.body.appendChild(script);
            loadedJS = script;
        });

        link.addEventListener('error', () => {
            document.dispatchEvent(new Event('theme-ready'));
            if (isSwitch) setTimeout(hideOverlay, 80);
        });

        setThemeIcon(themeName);
        localStorage.setItem(STORAGE_KEY, themeName);
        currentTheme = themeName;
    }

    function initTheme() {
        if (window.contentLoaded) {
            loadTheme(currentTheme);
        } else {
            document.addEventListener('content-loaded', () => loadTheme(currentTheme));
        }
    }

    let userHasManuallyToggled = !!savedTheme;

    themeToggle?.addEventListener('click', () => {
        userHasManuallyToggled = true;
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        loadTheme(newTheme);
    });

    // If the user hasn't manually picked a theme this session, follow OS-level changes live
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        if (!userHasManuallyToggled) {
            loadTheme(e.matches ? 'dark' : 'light');
        }
    });

    initTheme();
})();
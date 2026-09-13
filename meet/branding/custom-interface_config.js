// Griffin Fund additions, appended to Jitsi's interface_config.js.
// Colours live in griffin/branding.json; this file is names and chrome.

interfaceConfig.APP_NAME = 'Griffin Fund';
interfaceConfig.NATIVE_APP_NAME = 'Griffin Fund';
interfaceConfig.PROVIDER_NAME = 'Griffin Fund';

// Jitsi's own marks come off. Ours goes on, linking back to the club site.
interfaceConfig.SHOW_JITSI_WATERMARK = false;
interfaceConfig.JITSI_WATERMARK_LINK = '';
interfaceConfig.SHOW_WATERMARK_FOR_GUESTS = false;
interfaceConfig.SHOW_BRAND_WATERMARK = true;
interfaceConfig.BRAND_WATERMARK_LINK = 'https://thegriffinfund.org';
interfaceConfig.SHOW_POWERED_BY = false;
interfaceConfig.DEFAULT_LOGO_URL = '/griffin/wordmark.png';
interfaceConfig.DEFAULT_WELCOME_PAGE_LOGO_URL = '/griffin/wordmark.png';

// No app-store interstitials. Members are on a laptop.
interfaceConfig.MOBILE_APP_PROMO = false;
interfaceConfig.HIDE_DEEP_LINKING_LOGO = true;
interfaceConfig.SHOW_CHROME_EXTENSION_BANNER = false;

interfaceConfig.DEFAULT_BACKGROUND = '#0b2540';
interfaceConfig.DISABLE_VIDEO_BACKGROUND = false;
interfaceConfig.DISABLE_JOIN_LEAVE_NOTIFICATIONS = false;
interfaceConfig.DISABLE_PRESENCE_STATUS = false;
interfaceConfig.DISABLE_TRANSCRIPTION_SUBTITLES = true;
interfaceConfig.RECENT_LIST_ENABLED = false;
interfaceConfig.OPTIMAL_BROWSERS = [ 'chrome', 'chromium', 'firefox', 'electron', 'safari', 'webkit' ];
interfaceConfig.UNSUPPORTED_BROWSERS = [];

// A meeting is named for what it is, not for a random word pair.
interfaceConfig.GENERATE_ROOMNAMES_ON_WELCOME_PAGE = false;
interfaceConfig.DISPLAY_WELCOME_PAGE_CONTENT = true;
interfaceConfig.DISPLAY_WELCOME_PAGE_TOOLBAR_ADDITIONAL_CONTENT = false;
interfaceConfig.DISPLAY_WELCOME_FOOTER = false;

interfaceConfig.VIDEO_QUALITY_LABEL_DISABLED = false;
interfaceConfig.CONNECTION_INDICATOR_DISABLED = false;
interfaceConfig.TILE_VIEW_MAX_COLUMNS = 5;
interfaceConfig.VERTICAL_FILMSTRIP = true;

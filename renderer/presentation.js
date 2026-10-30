'use strict';

// Presentation only. The provisioning planner remains the source of every action.
(function (root) {
  const labels = {
    window_animation_scale: 'Open windows without a delay',
    transition_animation_scale: 'Move between screens faster',
    animator_duration_scale: 'Keep animations quick and readable',
    stay_on_while_plugged_in: 'Keep the screen on while plugged in',
    screen_off_timeout: 'Allow 30 minutes before the screen sleeps',
    screensaver_enabled: 'Turn off the screensaver',
    screensaver_activate_on_dock: 'Keep the order screen visible when docked',
    screensaver_activate_on_sleep: 'Prevent the screensaver taking over',
    screen_brightness_mode: 'Keep brightness steady',
    dim_screen: 'Stop the screen dimming before sleep',
    sem_low_power_brightness_limit: 'Remove the power-saving brightness limit',
    zen_mode: 'Turn off Do Not Disturb',
    heads_up_notifications_enabled: 'Allow notification banners',
    adaptive_battery_management_enabled: 'Stop adaptive battery limiting the order app',
    app_standby_enabled: 'Stop Android putting idle apps to sleep',
    low_power: 'Turn off battery saver',
    app_auto_restriction_enabled: 'Stop automatic app restrictions',
    automatic_power_save_mode: 'Turn off automatic power saving',
    auto_time: 'Set the clock automatically',
    auto_time_zone: 'Set the time zone automatically',
    wifi_scan_throttle_enabled: 'Allow Wi-Fi to reconnect promptly',
    wifi_sleep_policy: 'Keep Wi-Fi available during sleep',
    captive_portal_detection_enabled: 'Turn off Wi-Fi sign-in popups',
    battery_protected_charge: 'Enable Lenovo battery protection at 60%',
    protect_battery: 'Enable Samsung battery protection',
    adaptive_fast_charging: 'Turn off Samsung fast charging',
    'setting.duraspeed.enabled': 'Turn off DuraSpeed background limits',
  };

  function settingLabel(setting) {
    return labels[setting.key] || setting.key;
  }

  const packageNames = {
    'com.motorola.demo': 'Store demo mode',
    'com.tblenovo.whatsnewclient': 'Lenovo What’s New',
    'com.android.wantjoin.settings': 'Kid’s Mode settings',
    'com.android.wantjoin.childmode.ctrl': 'Kid’s Mode controls',
    'com.lmsa.app.lmsapad': 'Lenovo support helper',
    'com.verizon.remoteSimlock': 'Verizon SIM lock helper',
    'com.dolby.daxappui': 'Dolby Audio controls',
    'com.mediatek.duraspeed': 'DuraSpeed background limiter',
    'com.dti.lenovo.tablet': 'Digital Turbine game installer',
    'com.king.candycrushsaga': 'Candy Crush Saga',
    'com.pandora.android': 'Pandora',
    'com.particlenews.newsbreak': 'NewsBreak',
    'com.grubhub.android.orderhub': 'Grubhub’s order app',
    'com.grubhub.android.orderhub.settings': 'Grubhub settings helper',
    'com.grubhub.android.orderhub.installer': 'Grubhub installer',
    'com.grubhub.android.orderhub.recovery': 'Grubhub recovery helper',
    'com.gears42.surelock': 'SureLock kiosk software',
  };

  const packageLabel = pkg => packageNames[pkg] || pkg;

  function overview(report) {
    const apps = report.app || [];
    const prod = apps.find(a => a.pkg === 'com.pandaeats.ordertaking');
    const app = prod
      ? { title: 'Order app', value: prod.enabled === false ? 'Switched off' : 'Installed', detail: 'Run Check to test whether it can take orders.', kind: prod.enabled === false ? 'warn' : 'info', icon: 'bag' }
      : { title: 'Order app', value: 'Needs setup', detail: 'Install the production app in Set up.', kind: 'warn', icon: 'bag' };
    const survival = report.backgroundSurvival;
    const background = survival
      ? { title: 'Background activity', value: survival.ok === true ? 'DuraSpeed is off' : 'DuraSpeed needs attention', detail: survival.ok === true ? 'Both controls and the app state were checked.' : 'DuraSpeed can close the order app. Review Apply.', kind: survival.ok === true ? 'ok' : 'warn', icon: 'pulse' }
      : { title: 'Background activity', value: 'Check the order app', detail: 'The readiness check tests its background access.', kind: 'info', icon: 'pulse' };
    const protection = report.batteryProtection;
    const battery = protection && protection.supported !== false && protection.ok === true
      ? { title: 'Battery protection', value: '60% limit is on', detail: 'Lenovo’s battery protection control reads on.', kind: 'ok', icon: 'battery' }
      : protection
        ? { title: 'Battery protection', value: protection.supported === false ? 'Not confirmed' : '60% limit is off', detail: protection.supported === false ? 'Check Settings > Battery on the tablet.' : 'Apply can turn on Lenovo battery protection.', kind: 'warn', icon: 'battery' }
        : { title: 'Battery protection', value: 'See tablet details', detail: 'Charging controls vary by tablet model.', kind: 'info', icon: 'battery' };
    return [app, background, battery];
  }

  const api = { settingLabel, packageLabel, overview };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BenchPresentation = api;
})(typeof window === 'undefined' ? globalThis : window);

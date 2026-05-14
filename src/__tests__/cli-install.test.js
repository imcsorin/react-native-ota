const {
  patchAppDelegateSwift,
  patchAppPackageJson,
  patchMainApplicationKotlin,
} = require('../../scripts/cli-install');

describe('patchAppPackageJson', () => {
  it('adds the library dependency and public URL base config', () => {
    const result = patchAppPackageJson(
      JSON.stringify(
        {
          name: 'MyApp',
          dependencies: {
            react: '19.2.3',
          },
        },
        null,
        2
      ),
      {
        packageName: '@imcsorin/react-native-ota',
        publicUrlBase: 'https://cdn.example.com/mobile/prod',
      }
    );

    expect(JSON.parse(result.contents)).toEqual({
      'name': 'MyApp',
      'dependencies': {
        '@imcsorin/react-native-ota': 'latest',
        'react': '19.2.3',
      },
      'react-native-ota': {
        publicUrlBase: 'https://cdn.example.com/mobile/prod',
      },
    });
    expect(result.updatedDependency).toBe(true);
    expect(result.updatedPublicUrlBase).toBe(true);
  });

  it('replaces legacy manifestUrl config when writing publicUrlBase', () => {
    const result = patchAppPackageJson(
      JSON.stringify(
        {
          'name': 'MyApp',
          'react-native-ota': {
            manifestUrl: 'https://example.com/ota/manifest.json',
          },
        },
        null,
        2
      ),
      {
        packageName: '@imcsorin/react-native-ota',
        publicUrlBase: 'https://cdn.example.com/mobile/prod',
      }
    );

    expect(JSON.parse(result.contents)['react-native-ota']).toEqual({
      publicUrlBase: 'https://cdn.example.com/mobile/prod',
    });
    expect(result.updatedPublicUrlBase).toBe(true);
  });
});

describe('patchAppDelegateSwift', () => {
  const baseSource = `import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)

    factory.startReactNative(
      withModuleName: "MyApp",
      in: window,
      launchOptions: launchOptions
    )

    return true
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
`;

  it('adds OTA startup and bundle resolution', () => {
    const result = patchAppDelegateSwift(baseSource);

    expect(result).toContain('import ReactNativeOta');
    expect(result).toContain('RNOtaManager.shared.bundleURL()');
    expect(result).not.toContain(
      'Bundle.main.url(forResource: "main", withExtension: "jsbundle")'
    );
  });

  it('is idempotent', () => {
    const once = patchAppDelegateSwift(baseSource);

    expect(patchAppDelegateSwift(once)).toBe(once);
  });

  it('supports AppDelegate layouts that use an explicit return for the embedded bundle', () => {
    const modernSource = `import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import FirebaseCore

@main
class AppDelegate: RCTAppDelegate {
  override func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey : Any]? = nil) -> Bool {
    self.moduleName = "MyApp"
    self.dependencyProvider = RCTAppDependencyProvider()
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
    #if DEBUG
      return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
    #else
      return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
    #endif
  }
}
`;

    const result = patchAppDelegateSwift(modernSource);

    expect(result).toContain('import ReactNativeOta');
    expect(result).toContain('return RNOtaManager.shared.bundleURL()');
    expect(result).not.toContain(
      'return Bundle.main.url(forResource: "main", withExtension: "jsbundle")'
    );
  });
});

describe('patchMainApplicationKotlin', () => {
  const baseSource = `package com.myapp

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactNativeHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {
  override val reactNativeHost: ReactNativeHost by lazy {
    object : DefaultReactNativeHost(this) {
      override fun getPackages() = PackageList(this).packages

      override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG
    }
  }

  override val reactHost: ReactHost
    get() = getDefaultReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
`;

  it('adds OTA host wiring through getJSBundleFile only', () => {
    const result = patchMainApplicationKotlin(baseSource);

    expect(result).toContain(
      'import com.imcsorin.reactnativeota.ReactNativeOtaController'
    );
    expect(result).toMatch(
      /override fun getJSBundleFile\(\): String\? =\n\s+ReactNativeOtaController\.getJSBundleFile\(this@MainApplication\) \{\n\s+reactNativeHost\.clear\(\)\n\s+currentReactHost = null\n\s+\}/
    );
    expect(result).toContain('private var currentReactHost: ReactHost? = null');
    expect(result).not.toContain('ReactNativeOtaController.initialize(this)');
  });

  it('is idempotent', () => {
    const once = patchMainApplicationKotlin(baseSource);

    expect(patchMainApplicationKotlin(once)).toBe(once);
  });

  it('supports the newer React Native MainApplication template', () => {
    const modernSource = `package com.myapp

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost =
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages

        override fun getJSMainModuleName(): String = "index"

        override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

        override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
        override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
      }

  override val reactHost: ReactHost
    get() = getDefaultReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    load()
  }
}
`;

    const result = patchMainApplicationKotlin(modernSource);

    expect(result).toContain(
      'import com.imcsorin.reactnativeota.ReactNativeOtaController'
    );
    expect(result).toMatch(
      /override fun getJSBundleFile\(\): String\? =\n\s+ReactNativeOtaController\.getJSBundleFile\(this@MainApplication\) \{\n\s+reactNativeHost\.clear\(\)\n\s+currentReactHost = null\n\s+\}/
    );
    expect(result).toContain('private var currentReactHost: ReactHost? = null');
  });
});

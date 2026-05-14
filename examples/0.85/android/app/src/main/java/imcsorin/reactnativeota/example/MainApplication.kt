package imcsorin.reactnativeota.example

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.imcsorin.reactnativeota.ReactNativeOtaController

class MainApplication : Application(), ReactApplication {
  override val reactNativeHost: ReactNativeHost by lazy {
    object : DefaultReactNativeHost(this) {
      override fun getPackages() =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
        }

      override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

      override fun getJSBundleFile(): String? =
        ReactNativeOtaController.getJSBundleFile(this@MainApplication) {
          reactNativeHost.clear()
          currentReactHost = null
        }
    }
  }

  private var currentReactHost: ReactHost? = null

  override val reactHost: ReactHost
    get() {
      if (currentReactHost == null) {
        currentReactHost =
          getDefaultReactHost(
            context = applicationContext,
            reactNativeHost = reactNativeHost
          )
      }

      return currentReactHost!!
    }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}

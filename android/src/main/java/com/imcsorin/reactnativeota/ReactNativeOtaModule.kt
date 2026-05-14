package com.imcsorin.reactnativeota

import com.facebook.react.bridge.ReactApplicationContext

class ReactNativeOtaModule(reactContext: ReactApplicationContext) :
  NativeReactNativeOtaSpec(reactContext) {

  companion object {
    const val NAME = NativeReactNativeOtaSpec.NAME
  }
}

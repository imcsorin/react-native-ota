package com.imcsorin.reactnativeota

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.bridge.ReactMarker
import com.facebook.react.bridge.ReactMarkerConstants
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.ZipInputStream
import kotlin.concurrent.thread
import org.json.JSONObject

object ReactNativeOtaController {
  private const val TAG = "ReactNativeOta"
  private const val PREFERENCES_NAME = "react-native-ota"
  private const val STATE_KEY = "state"
  private const val STORAGE_DIRECTORY_NAME = "react-native-ota"
  private const val CONFIG_ASSET_FILE_NAME = "react-native-ota.json"
  private const val BUNDLE_FILE_NAME = "index.android.bundle"
  private const val GRACE_PERIOD_MILLIS = 3_000L
  private const val MANIFEST_ROOT_PATH = "manifests"
  private const val MANIFEST_PLATFORM_PATH = "android"

  private val hasInitialized = AtomicBoolean(false)

  // Host apps call this from ReactNativeHost.getJSBundleFile() so React Native can load the
  // installed OTA bundle when one exists, or fall back to the embedded bundle when it does not.
  @JvmStatic
  fun getJSBundleFile(
    application: Application,
    invalidateReactHost: (() -> Unit)? = null
  ): String? {
    if (invalidateReactHost != null) {
      initialize(application, invalidateReactHost)
    }

    val rawState =
      application
        .getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
        .getString(STATE_KEY, null)
        ?: return null

    return try {
      val state = JSONObject(rawState)
      val current = state.optJSONObject("current")
      val previous = state.optJSONObject("previous")

      val currentBundlePath = current?.optString("bundlePath")?.trim().orEmpty()
      val currentPackageRootPath = current?.optString("packageRootPath")?.trim().orEmpty()
      val previousBundlePath = previous?.optString("bundlePath")?.trim().orEmpty()
      val previousPackageRootPath = previous?.optString("packageRootPath")?.trim().orEmpty()
      val currentIsUsable =
        currentBundlePath.isNotEmpty() &&
          currentPackageRootPath.isNotEmpty() &&
          File(currentBundlePath).isFile &&
          File(currentPackageRootPath).isDirectory
      val previousIsUsable =
        previousBundlePath.isNotEmpty() &&
          previousPackageRootPath.isNotEmpty() &&
          File(previousBundlePath).isFile &&
          File(previousPackageRootPath).isDirectory

      when {
        currentIsUsable -> currentBundlePath
        previousIsUsable -> previousBundlePath
        else -> null
      }
    } catch (error: Exception) {
      Log.w(TAG, "Failed to decode OTA state", error)
      null
    }
  }

  // Host apps call this once from Application.onCreate() before React boots. It restores any
  // persisted OTA bundle state, rolls back failed bundles, checks for a new update, installs it,
  // reloads React Native, and confirms the new bundle after it renders.
  @JvmStatic
  fun initialize(
    application: Application,
    invalidateReactHost: () -> Unit
  ) {
    if (!hasInitialized.compareAndSet(false, true)) {
      return
    }

    data class BundleRecord(
      val bundleVersion: Long,
      val bundlePath: String,
      val packageRootPath: String
    )

    val mainHandler = Handler(Looper.getMainLooper())
    val preferences = application.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    val storageRoot = File(application.filesDir, STORAGE_DIRECTORY_NAME)
    val bundlesRoot = File(storageRoot, "bundles")
    val tempRoot = File(storageRoot, "tmp")

    // These values are kept in memory after initialize returns because the callbacks below keep
    // running for the lifetime of the app process.
    var currentBundle: BundleRecord? = null
    var previousBundle: BundleRecord? = null

    // A pending bundle has been installed but has not rendered successfully yet. If the app dies
    // while this is true, the next launch treats that bundle as failed and rolls back.
    var currentPending = false

    // We need the visible Activity so activating an OTA bundle reloads what the user is seeing.
    var currentActivity: Activity? = null

    // Confirmation is delayed so crashes during startup still trigger rollback on the next launch.
    var confirmationRunnable: Runnable? = null

    // This prevents ReactMarker events from confirming an older bundle while a new one activates.
    var activatingBundleVersion: Long? = null

    // Stored JSON is treated as untrusted because old app versions or manual edits may leave
    // missing fields behind.
    val restoreBundleRecord: (JSONObject?) -> BundleRecord? = { bundleState ->
      if (bundleState == null) {
        null
      } else {
        val bundleVersion = parseBundleVersionValue(bundleState.opt("bundleVersion"))
        val bundlePath = bundleState.optString("bundlePath").trim()
        val packageRootPath = bundleState.optString("packageRootPath").trim()

        if (bundleVersion == null || bundlePath.isEmpty() || packageRootPath.isEmpty()) {
          null
        } else {
          BundleRecord(
            bundleVersion = bundleVersion,
            bundlePath = bundlePath,
            packageRootPath = packageRootPath
          )
        }
      }
    }
    val deleteBundleDirectory: (BundleRecord) -> Unit = { bundle ->
      val packageRoot = File(bundle.packageRootPath)
      if (packageRoot.exists() && !packageRoot.deleteRecursively()) {
        Log.w(TAG, "Failed to delete bundle directory ${packageRoot.absolutePath}")
      }
    }

    // If state points at missing files, ignore it and remove the broken bundle directory.
    val sanitizeBundleRecord: (BundleRecord?) -> BundleRecord? = { bundle ->
      if (
        bundle == null ||
          (File(bundle.bundlePath).isFile && File(bundle.packageRootPath).isDirectory)
      ) {
        bundle
      } else {
        deleteBundleDirectory(bundle)
        null
      }
    }

    fun persistState() {
      // Persist enough information for getJSBundleFile() to choose a bundle before React starts.
      fun bundleToJson(bundle: BundleRecord?): Any {
        if (bundle == null) {
          return JSONObject.NULL
        }

        return JSONObject()
          .put("bundleVersion", bundle.bundleVersion)
          .put("bundlePath", bundle.bundlePath)
          .put("packageRootPath", bundle.packageRootPath)
      }

      val state =
        JSONObject()
          .put("current", bundleToJson(currentBundle))
          .put("previous", bundleToJson(previousBundle))
          .put("currentPending", currentPending)

      preferences.edit().putString(STATE_KEY, state.toString()).apply()
      Log.w(
        TAG,
        "Persisted OTA state (current=${currentBundle?.bundleVersion ?: "embedded"}, previous=${previousBundle?.bundleVersion ?: "none"}, pending=$currentPending)"
      )
    }

    fun activatePendingBundleIfPossible() {
      // Activation is safe to call often; it only does work when there is a pending bundle.
      val pendingBundle = if (currentPending) currentBundle else null
      if (pendingBundle == null) {
        return
      }

      val bundleVersion = pendingBundle.bundleVersion
      if (activatingBundleVersion == bundleVersion) {
        // The Activity is already being recreated for this bundle.
        return
      }

      val activity = currentActivity
      if (activity == null) {
        // The activity callback will try again when the app has a visible screen.
        Log.w(
          TAG,
          "Deferring OTA bundle activation for $bundleVersion until an activity is resumed"
        )
        return
      }

      activatingBundleVersion = bundleVersion
      Log.w(TAG, "Recreating activity to activate OTA bundle $bundleVersion")
      // ReactNativeHost caches the bundle path, so invalidate it before the Activity reloads.
      invalidateReactHost()
      activity.recreate()
    }

    // Restore persisted OTA bundle state.
    bundlesRoot.mkdirs()
    tempRoot.mkdirs()

    val rawState = preferences.getString(STATE_KEY, null)
    if (!rawState.isNullOrEmpty()) {
      try {
        val state = JSONObject(rawState)
        currentBundle = restoreBundleRecord(state.optJSONObject("current"))
        previousBundle = restoreBundleRecord(state.optJSONObject("previous"))
        currentPending = state.optBoolean("currentPending", false)
      } catch (error: Exception) {
        Log.w(TAG, "Failed to decode OTA state", error)
      }
    }

    currentBundle = sanitizeBundleRecord(currentBundle)
    previousBundle = sanitizeBundleRecord(previousBundle)

    // Roll back a bundle that never reached confirmation on the previous launch.
    if (currentPending) {
      Log.w(TAG, "Rolling back pending OTA bundle ${currentBundle?.bundleVersion ?: "unknown"}")
      val failedBundle = currentBundle
      if (failedBundle != null) {
        deleteBundleDirectory(failedBundle)
      }
      currentBundle = previousBundle
      previousBundle = null
      currentPending = false
    } else if (currentBundle == null) {
      // If the current bundle disappeared but the previous one is still usable, fall back to it.
      currentBundle = previousBundle
      previousBundle = null
    }

    persistState()

    // Track the activity currently on screen so reloads target the visible UI.
    application.registerActivityLifecycleCallbacks(
      object : Application.ActivityLifecycleCallbacks {
        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit

        override fun onActivityStarted(activity: Activity) = Unit

        override fun onActivityResumed(activity: Activity) {
          currentActivity = activity
          mainHandler.post { activatePendingBundleIfPossible() }
        }

        override fun onActivityPaused(activity: Activity) {
          if (currentActivity === activity) {
            currentActivity = null
          }
        }

        override fun onActivityStopped(activity: Activity) = Unit

        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

        override fun onActivityDestroyed(activity: Activity) {
          if (currentActivity === activity) {
            currentActivity = null
          }
        }
      }
    )

    // CONTENT_APPEARED means React rendered something. We still wait a short grace period before
    // confirming so crashes immediately after first render are treated as failed updates.
    ReactMarker.addListener(
      ReactMarker.MarkerListener { name, _, _ ->
        if (name != ReactMarkerConstants.CONTENT_APPEARED) {
          return@MarkerListener
        }

        mainHandler.post {
          // ReactMarker can fire from non-main threads, so keep state changes on the main thread.
          val pendingBundle = if (currentPending) currentBundle else null
          if (pendingBundle != null) {
            if (activatingBundleVersion != pendingBundle.bundleVersion) {
              Log.w(
                TAG,
                "Ignoring content appeared because OTA bundle ${pendingBundle.bundleVersion} has not been activated yet"
              )
            } else {
              Log.w(
                TAG,
                "Content appeared for pending OTA bundle ${pendingBundle.bundleVersion}; scheduling confirmation"
              )

              val previousConfirmationRunnable = confirmationRunnable
              if (previousConfirmationRunnable != null) {
                // Multiple content events can fire during startup; only the latest timer matters.
                mainHandler.removeCallbacks(previousConfirmationRunnable)
              }
              val runnable =
                Runnable {
                  val bundle = if (currentPending) currentBundle else null
                  if (bundle != null) {
                    // Rendering survived the grace period, so this bundle becomes trusted.
                    currentPending = false
                    persistState()
                    Log.w(TAG, "Confirmed OTA bundle ${bundle.bundleVersion}")
                  }
                  activatingBundleVersion = null
                }
              confirmationRunnable = runnable
              mainHandler.postDelayed(runnable, GRACE_PERIOD_MILLIS)
            }
          }
        }
      }
    )

    // The update check runs in the background, but bundle state is changed only on the main thread.
    // Capture the current version before the thread starts so the background work uses a stable
    // comparison value.
    val currentBundleVersionAtUpdateCheckStart = currentBundle?.bundleVersion

    // Check manifest for a newer compatible bundle.
    thread(name = "ReactNativeOtaUpdateCheck") {
      try {
        // binaryVersion makes sure a bundle is only installed into the native app it was built for.
        val packageInfo =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            application.packageManager.getPackageInfo(
              application.packageName,
              PackageManager.PackageInfoFlags.of(0)
            )
          } else {
            @Suppress("DEPRECATION")
            application.packageManager.getPackageInfo(application.packageName, 0)
          }
        val binaryVersion = packageInfo.versionName?.trim()
        check(!binaryVersion.isNullOrEmpty()) {
          "Android package versionName must be set for OTA binaryVersion matching"
        }
        val resolvedBinaryVersion = binaryVersion!!

        val publicUrlBase = readConfiguredPublicUrlBase(application)
        if (publicUrlBase == null) {
          Log.w(TAG, "Skipping OTA update check because no public URL base is configured")
          return@thread
        }

        val manifestUrl = buildManifestUrl(publicUrlBase, resolvedBinaryVersion)
        if (manifestUrl == null) {
          return@thread
        }

        Log.w(
          TAG,
          "Checking for OTA update (binaryVersion=$resolvedBinaryVersion, current=${currentBundleVersionAtUpdateCheckStart ?: "embedded"}, manifestUrl=$manifestUrl)"
        )

        val manifestBody =
          (manifestUrl.openConnection() as HttpURLConnection).run {
            connectTimeout = 15_000
            readTimeout = 60_000
            instanceFollowRedirects = true
            setRequestProperty("Accept", "application/json")

            try {
              connect()
              val statusCode = responseCode
              check(statusCode in 200..299) {
                "manifest fetch failed with HTTP $statusCode"
              }
              inputStream.buffered().use {
                it.readBytes().decodeToString()
              }
            } finally {
              disconnect()
            }
          }

        Log.w(TAG, "Received OTA manifest: $manifestBody")
        val manifest = JSONObject(manifestBody)
        val manifestBundleVersion = parseBundleVersionValue(manifest.opt("bundleVersion"))
        val downloadUrlValue = manifest.optString("downloadUrl").trim()

        check(manifestBundleVersion != null) {
          "Manifest root is missing required field bundleVersion"
        }
        check(downloadUrlValue.isNotEmpty()) {
          "Manifest root is missing required field downloadUrl"
        }

        if (manifestBundleVersion == currentBundleVersionAtUpdateCheckStart) {
          Log.w(
            TAG,
            "Ignoring manifest entry because bundleVersion $manifestBundleVersion is already current"
          )
          return@thread
        }

        val currentBundleVersion = currentBundleVersionAtUpdateCheckStart
        if (currentBundleVersion != null) {
          if (manifestBundleVersion <= currentBundleVersion) {
            Log.w(
              TAG,
              "Ignoring manifest entry because bundleVersion $manifestBundleVersion is not newer than current $currentBundleVersion"
            )
            return@thread
          }
        }

        // Keep the directory name filesystem-safe while preserving the real version in state.
        val safeBundleVersion = manifestBundleVersion.toString()
        val archiveFile = File(tempRoot, "download-$safeBundleVersion.zip")
        val extractedDir = File(tempRoot, "extract-$safeBundleVersion")
        val destinationDir = File(bundlesRoot, safeBundleVersion)
        val downloadUrl = URL(downloadUrlValue)

        // Download and install the new bundle.
        // Start from clean paths so a failed earlier attempt cannot contaminate this install.
        archiveFile.delete()
        extractedDir.deleteRecursively()
        destinationDir.deleteRecursively()
        extractedDir.mkdirs()

        Log.w(TAG, "Downloading OTA archive $downloadUrl")
        (downloadUrl.openConnection() as HttpURLConnection).run {
          connectTimeout = 15_000
          readTimeout = 60_000
          instanceFollowRedirects = true

          try {
            connect()
            val statusCode = responseCode
            check(statusCode in 200..299) {
              "archive download failed with HTTP $statusCode"
            }
            archiveFile.parentFile?.mkdirs()
            inputStream.buffered().use { inputStream ->
              FileOutputStream(archiveFile).use { outputStream ->
                inputStream.copyTo(outputStream)
              }
            }
          } finally {
            disconnect()
          }
        }

        Log.w(TAG, "Installing OTA archive for bundle $manifestBundleVersion")
        try {
          ZipInputStream(FileInputStream(archiveFile).buffered()).use { zipInputStream ->
            val canonicalRoot = extractedDir.canonicalFile
            while (true) {
              val entry = zipInputStream.nextEntry ?: break
              val outputFile = File(extractedDir, entry.name)
              val canonicalOutputFile = outputFile.canonicalFile

              // Prevent a malicious archive from writing outside our temp directory.
              check(
                canonicalOutputFile.path == canonicalRoot.path ||
                  canonicalOutputFile.path.startsWith(canonicalRoot.path + File.separator)
              ) {
                "Archive entry escapes extraction root: ${entry.name}"
              }

              if (entry.isDirectory) {
                canonicalOutputFile.mkdirs()
              } else {
                canonicalOutputFile.parentFile?.mkdirs()
                FileOutputStream(canonicalOutputFile).use { outputStream ->
                  zipInputStream.copyTo(outputStream)
                }
              }

              zipInputStream.closeEntry()
            }
          }

          val bundleFile = File(extractedDir, BUNDLE_FILE_NAME)
          check(bundleFile.isFile) {
            "Extracted archive is missing $BUNDLE_FILE_NAME"
          }

          // Only promote the extracted directory after the whole archive is verified.
          if (!extractedDir.renameTo(destinationDir)) {
            throw IllegalStateException(
              "Failed to promote extracted archive to ${destinationDir.absolutePath}"
            )
          }
        } catch (error: Exception) {
          extractedDir.deleteRecursively()
          destinationDir.deleteRecursively()
          throw error
        } finally {
          archiveFile.delete()
        }

        val installedBundle =
          BundleRecord(
            bundleVersion = manifestBundleVersion,
            bundlePath = File(destinationDir, BUNDLE_FILE_NAME).absolutePath,
            packageRootPath = destinationDir.absolutePath
          )

        // Network and file work happened off the main thread. State updates and Activity reloads
        // happen on the main thread so lifecycle callbacks see a consistent state.
        mainHandler.post {
          val oldCurrentBundle = currentBundle
          val staleBundle =
            if (previousBundle?.bundleVersion == oldCurrentBundle?.bundleVersion) {
              null
            } else {
              previousBundle
            }

          currentBundle = installedBundle
          previousBundle = oldCurrentBundle

          // Mark pending before reload. If this bundle crashes before confirmation, startup will
          // roll back to previousBundle.
          currentPending = true
          persistState()

          if (staleBundle != null) {
            // Keep only the active bundle and its rollback candidate.
            deleteBundleDirectory(staleBundle)
          }

          activatePendingBundleIfPossible()
        }
      } catch (error: Exception) {
        Log.w(TAG, "Update check failed", error)
      }
    }
  }

  private fun buildManifestUrl(
    publicUrlBase: String,
    binaryVersion: String
  ): URL? {
    if (binaryVersion.contains("/")) {
      Log.w(
        TAG,
        "Skipping OTA update check because binaryVersion contains unsupported path separators"
      )
      return null
    }

    return try {
      URL(
        Uri
          .parse(publicUrlBase)
          .buildUpon()
          .appendPath(MANIFEST_ROOT_PATH)
          .appendPath(MANIFEST_PLATFORM_PATH)
          .appendPath("$binaryVersion.json")
          .build()
          .toString()
      )
    } catch (error: Exception) {
      Log.w(TAG, "Invalid package.json OTA publicUrlBase: $publicUrlBase", error)
      null
    }
  }

  private fun readConfiguredPublicUrlBase(application: Application): String? =
    try {
      val config =
        JSONObject(
          application.assets.open(CONFIG_ASSET_FILE_NAME).bufferedReader().use {
            it.readText()
          }
        )
      val rawPublicUrlBase = config.optString("publicUrlBase").trim()

      if (rawPublicUrlBase.isEmpty()) {
        null
      } else {
        rawPublicUrlBase
      }
    } catch (error: Exception) {
      Log.w(TAG, "Invalid package.json OTA config asset", error)
      null
    }

  private fun parseBundleVersionValue(value: Any?): Long? {
    return when (value) {
      is Number -> {
        val longValue = value.toLong()
        if (longValue >= 0 && value.toDouble() == longValue.toDouble()) {
          longValue
        } else {
          null
        }
      }
      is String -> {
        val normalizedValue = value.trim()
        if (normalizedValue.isEmpty() || !normalizedValue.all(Char::isDigit)) {
          null
        } else {
          normalizedValue.toLongOrNull()?.takeIf { it >= 0 }
        }
      }
      else -> null
    }
  }
}

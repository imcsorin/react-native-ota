import Foundation
import React
import SSZipArchive

private struct BundleRecord: Codable {
  let bundleVersion: String
  let bundlePath: String
  let packageRootPath: String
}

private struct PersistedState: Codable {
  var current: BundleRecord?
  var previous: BundleRecord?
  var currentPending: Bool

  init(
    current: BundleRecord? = nil,
    previous: BundleRecord? = nil,
    currentPending: Bool = false
  ) {
    self.current = current
    self.previous = previous
    self.currentPending = currentPending
  }

  enum CodingKeys: String, CodingKey {
    case current
    case previous
    case currentPending
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    current = try container.decodeIfPresent(BundleRecord.self, forKey: .current)
    previous = try container.decodeIfPresent(BundleRecord.self, forKey: .previous)
    currentPending = try container.decodeIfPresent(Bool.self, forKey: .currentPending) ?? false
  }
}

private struct ManifestEntry {
  let bundleVersion: Int
  let downloadURL: URL
}

private enum OtaError: LocalizedError {
  case invalidArchive(String)
  case invalidManifest(String)

  var errorDescription: String? {
    switch self {
    case .invalidArchive(let message), .invalidManifest(let message):
      return message
    }
  }
}

private extension Character {
  var isASCIIAlphaNumericOrHyphen: Bool {
    unicodeScalars.allSatisfy { scalar in
      scalar.isASCII &&
        (
          CharacterSet.alphanumerics.contains(scalar) ||
            scalar.value == 45
        )
    }
  }

  var isASCIIWholeNumber: Bool {
    unicodeScalars.allSatisfy { scalar in
      scalar.isASCII && CharacterSet.decimalDigits.contains(scalar)
    }
  }
}

@objc(RNOtaManager)
public final class RNOtaManager: NSObject {
  @objc(sharedManager)
  public static let shared = RNOtaManager()

  private let bundleFileName = "main.jsbundle"
  private let manifestPlatformKey = "ios"
  private let manifestRootPath = "manifests"
  private let contentDidAppearNotification = NSNotification.Name.RCTContentDidAppear
  private let defaultsKey = "com.imcsorin.reactnativeota.state"
  private let oldDefaultsKey = "com.imcsorin.reactnativeota.ios.state"
  private let gracePeriodSeconds = 3.0
  private let queue = DispatchQueue(label: "com.imcsorin.reactnativeota")
  private let userDefaults = UserDefaults.standard

  private var activatingBundleVersion: String?
  private var confirmationWorkItem: DispatchWorkItem?
  private var contentObserver: NSObjectProtocol?
  private var didPrepareLaunchState = false
  private var hasInitialized = false
  private var hasRegisteredObservers = false
  private var isCheckingForUpdate = false
  private var state = PersistedState()

  private override init() {
    super.init()
  }

  // Host apps call this once before React boots. It restores persisted OTA bundle state, rolls
  // back failed bundles, registers bundle confirmation, and starts checking for a new update.
  @objc(initialize)
  public func initialize() {
    var shouldStartOtaFlow = false

    queue.sync {
      prepareLaunchStateIfNeeded()

      if !hasInitialized {
        hasInitialized = true
        shouldStartOtaFlow = true
      }
    }

    if shouldStartOtaFlow {
      registerObserversIfNeeded()
      checkForUpdate()
    }
  }

  // Host apps call this from their React bridge delegate so React Native can load the installed
  // OTA bundle when one exists, or fall back to the embedded bundle when it does not.
  @objc(bundleURL)
  public func bundleURL() -> URL? {
    let shouldStartOtaFlow = queue.sync { () -> Bool in
      prepareLaunchStateIfNeeded()

      if hasInitialized {
        return false
      }

      hasInitialized = true
      return true
    }

    if shouldStartOtaFlow {
      registerObserversIfNeeded()
      checkForUpdate()
    }

    return queue.sync {
      prepareLaunchStateIfNeeded()
      return selectedBundleURL()
    }
  }

  private func selectedBundleURL() -> URL? {
    if let current = state.current, isUsable(record: current) {
      return URL(fileURLWithPath: current.bundlePath)
    }

    if let previous = state.previous, isUsable(record: previous) {
      return URL(fileURLWithPath: previous.bundlePath)
    }

    return embeddedBundleURL
  }

  private var embeddedBundleURL: URL? {
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
  }

  // This mirrors the Android controller: restore state, drop broken bundles, roll back unfinished
  // installs, and persist the cleaned-up state before React starts.
  private func prepareLaunchStateIfNeeded() {
    guard !didPrepareLaunchState else {
      return
    }

    didPrepareLaunchState = true
    createStorageDirectoriesIfNeeded()
    state = loadState()
    sanitizeState()

    if state.currentPending {
      rollbackPendingBundle()
    } else if state.current == nil {
      state.current = state.previous
      state.previous = nil
      saveState()
    } else {
      saveState()
    }
  }

  private func registerObserversIfNeeded() {
    guard !hasRegisteredObservers else {
      return
    }

    hasRegisteredObservers = true

    // CONTENT_DID_APPEAR means React rendered something. We still wait a short grace period so a
    // crash right after first render is treated as a failed update on the next launch.
    contentObserver = NotificationCenter.default.addObserver(
      forName: contentDidAppearNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.handleContentDidAppear()
    }
  }

  private func handleContentDidAppear() {
    queue.async {
      self.prepareLaunchStateIfNeeded()

      guard self.state.currentPending, let pendingBundle = self.state.current else {
        return
      }

      guard self.activatingBundleVersion == pendingBundle.bundleVersion else {
        self.log(
          "Ignoring content appeared because OTA bundle \(pendingBundle.bundleVersion) has not been activated yet"
        )
        return
      }

      self.log(
        "Content appeared for pending OTA bundle \(pendingBundle.bundleVersion); scheduling confirmation"
      )

      let workItem = DispatchWorkItem { [weak self] in
        self?.queue.async {
          self?.confirmPendingBundle()
        }
      }

      self.confirmationWorkItem?.cancel()
      self.confirmationWorkItem = workItem

      DispatchQueue.main.asyncAfter(
        deadline: .now() + self.gracePeriodSeconds,
        execute: workItem
      )
    }
  }

  private func checkForUpdate() {
    queue.async {
      self.prepareLaunchStateIfNeeded()

      guard !self.isCheckingForUpdate else {
        return
      }

      let binaryVersion = self.installedBinaryVersion.trimmingCharacters(
        in: .whitespacesAndNewlines
      )
      guard !binaryVersion.isEmpty else {
        self.log("Skipping OTA update check because CFBundleShortVersionString is empty")
        return
      }

      guard let manifestURL = self.derivedManifestURL(binaryVersion: binaryVersion) else {
        self.log("Skipping OTA update check because no public URL base is configured")
        return
      }

      self.isCheckingForUpdate = true
      let currentBundleVersion = self.state.current?.bundleVersion

      self.log(
        "Checking for OTA update (binaryVersion=\(binaryVersion), current=\(currentBundleVersion ?? "embedded"), manifestUrl=\(manifestURL.absoluteString))"
      )

      self.fetchManifest(
        manifestURL: manifestURL,
        currentBundleVersion: currentBundleVersion
      )
    }
  }

  private var installedBinaryVersion: String {
    (Bundle.main.object(
      forInfoDictionaryKey: "CFBundleShortVersionString"
    ) as? String) ?? ""
  }

  private var configuredPublicURLBase: URL? {
    if
      let rawPublicURLBase = RNOtaGeneratedConfig.publicURLBaseString?
        .trimmingCharacters(in: .whitespacesAndNewlines),
      !rawPublicURLBase.isEmpty
    {
      if let publicURLBase = URL(string: rawPublicURLBase) {
        return publicURLBase
      }

      log("Invalid package.json OTA publicUrlBase: \(rawPublicURLBase)")
    }

    return nil
  }

  private func derivedManifestURL(binaryVersion: String) -> URL? {
    guard let publicURLBase = configuredPublicURLBase else {
      return nil
    }

    guard !binaryVersion.contains("/") else {
      log("Skipping OTA update check because binaryVersion contains unsupported path separators")
      return nil
    }

    return publicURLBase.appendingPathComponent(
      "\(manifestRootPath)/\(manifestPlatformKey)/\(binaryVersion).json"
    )
  }

  private var storageRootURL: URL {
    let baseURL =
      FileManager.default.urls(
        for: .applicationSupportDirectory,
        in: .userDomainMask
      ).first
      ?? FileManager.default.urls(
        for: .libraryDirectory,
        in: .userDomainMask
      ).first!

    return baseURL.appendingPathComponent("ReactNativeOta", isDirectory: true)
  }

  private var bundlesRootURL: URL {
    storageRootURL.appendingPathComponent("bundles", isDirectory: true)
  }

  private var tempRootURL: URL {
    storageRootURL.appendingPathComponent("tmp", isDirectory: true)
  }

  private func fetchManifest(
    manifestURL: URL,
    currentBundleVersion: String?
  ) {
    var request = URLRequest(url: manifestURL)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.timeoutInterval = 15
    request.setValue("application/json", forHTTPHeaderField: "Accept")

    URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
      guard let self else {
        return
      }

      if let error {
        self.log("Manifest fetch failed: \(error.localizedDescription)")
        self.completeUpdateCheck()
        return
      }

      if let httpResponse = response as? HTTPURLResponse,
         !(200...299).contains(httpResponse.statusCode)
      {
        self.log("Manifest fetch failed with HTTP \(httpResponse.statusCode)")
        self.completeUpdateCheck()
        return
      }

      guard let data else {
        self.log("Manifest fetch failed: empty response body")
        self.completeUpdateCheck()
        return
      }

      if let manifestBody = String(data: data, encoding: .utf8) {
        self.log("Received OTA manifest: \(manifestBody)")
      }

      do {
        guard
          let entry = try self.selectManifestEntry(
            from: data,
            currentBundleVersion: currentBundleVersion
          )
        else {
          self.completeUpdateCheck()
          return
        }

        self.downloadArchive(for: entry)
      } catch {
        self.log("Manifest evaluation failed: \(error.localizedDescription)")
        self.completeUpdateCheck()
      }
    }.resume()
  }

  private func selectManifestEntry(
    from data: Data,
    currentBundleVersion: String?
  ) throws -> ManifestEntry? {
    guard
      let manifest = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      throw OtaError.invalidManifest("Manifest root must be a JSON object")
    }

    let bundleVersion = parseBundleVersionValue(manifest["bundleVersion"])
    let downloadURLString = (manifest["downloadUrl"] as? String)?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

    guard let bundleVersion else {
      throw OtaError.invalidManifest("Manifest root is missing required field bundleVersion")
    }

    guard !downloadURLString.isEmpty, let downloadURL = URL(string: downloadURLString) else {
      throw OtaError.invalidManifest("Manifest root is missing required field downloadUrl")
    }

    guard parseBundleVersionValue(currentBundleVersion) != bundleVersion else {
      log("Ignoring manifest entry because bundleVersion \(bundleVersion) is already current")
      return nil
    }

    if let currentBundleVersion = parseBundleVersionValue(currentBundleVersion) {
      guard bundleVersion > currentBundleVersion else {
        log(
          "Ignoring manifest entry because bundleVersion \(bundleVersion) is not newer than current \(currentBundleVersion)"
        )
        return nil
      }
    }

    return ManifestEntry(bundleVersion: bundleVersion, downloadURL: downloadURL)
  }

  private func downloadArchive(for entry: ManifestEntry) {
    var request = URLRequest(url: entry.downloadURL)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.timeoutInterval = 60

    URLSession.shared.downloadTask(with: request) { [weak self] temporaryURL, response, error in
      guard let self else {
        return
      }

      if let error {
        self.log("Archive download failed: \(error.localizedDescription)")
        self.completeUpdateCheck()
        return
      }

      if let httpResponse = response as? HTTPURLResponse,
         !(200...299).contains(httpResponse.statusCode)
      {
        self.log("Archive download failed with HTTP \(httpResponse.statusCode)")
        self.completeUpdateCheck()
        return
      }

      guard let temporaryURL else {
        self.log("Archive download failed: missing temporary file")
        self.completeUpdateCheck()
        return
      }

      do {
        let stagedArchiveURL = try self.stageDownloadedArchive(
          temporaryURL: temporaryURL,
          bundleVersion: entry.bundleVersion
        )

        self.queue.async {
          defer {
            try? FileManager.default.removeItem(at: stagedArchiveURL)
            self.completeUpdateCheckNow()
          }

          do {
            try self.installArchive(archiveURL: stagedArchiveURL, entry: entry)
          } catch {
            self.log("Archive install failed: \(error.localizedDescription)")
          }
        }
      } catch {
        self.log("Archive staging failed: \(error.localizedDescription)")
        self.completeUpdateCheck()
      }
    }.resume()
  }

  private func stageDownloadedArchive(
    temporaryURL: URL,
    bundleVersion: Int
  ) throws -> URL {
    let destinationURL = tempRootURL.appendingPathComponent(
      "download-\(safePathComponent(String(bundleVersion))).zip"
    )
    let fileManager = FileManager.default

    if fileManager.fileExists(atPath: destinationURL.path) {
      try fileManager.removeItem(at: destinationURL)
    }

    try fileManager.createDirectory(
      at: tempRootURL,
      withIntermediateDirectories: true,
      attributes: nil
    )
    try fileManager.moveItem(at: temporaryURL, to: destinationURL)

    return destinationURL
  }

  private func installArchive(
    archiveURL: URL,
    entry: ManifestEntry
  ) throws {
    let fileManager = FileManager.default
    let safeBundleVersion = safePathComponent(String(entry.bundleVersion))
    let extractedURL = tempRootURL.appendingPathComponent(
      "extract-\(safeBundleVersion)",
      isDirectory: true
    )
    let destinationURL = bundlesRootURL.appendingPathComponent(
      safeBundleVersion,
      isDirectory: true
    )

    try? fileManager.removeItem(at: extractedURL)
    try? fileManager.removeItem(at: destinationURL)
    try fileManager.createDirectory(
      at: extractedURL,
      withIntermediateDirectories: true,
      attributes: nil
    )

    do {
      log("Installing OTA archive for bundle \(entry.bundleVersion)")
      try extractArchive(at: archiveURL, to: extractedURL)

      let extractedBundleURL = extractedURL.appendingPathComponent(bundleFileName)
      guard fileManager.fileExists(atPath: extractedBundleURL.path) else {
        throw OtaError.invalidArchive("Extracted archive is missing \(bundleFileName)")
      }

      try fileManager.moveItem(at: extractedURL, to: destinationURL)

      let oldCurrentBundle = state.current
      let staleBundle =
        state.previous?.bundleVersion == oldCurrentBundle?.bundleVersion
          ? nil
          : state.previous

      state.current = BundleRecord(
        bundleVersion: String(entry.bundleVersion),
        bundlePath: destinationURL.appendingPathComponent(bundleFileName).path,
        packageRootPath: destinationURL.path
      )
      state.previous = oldCurrentBundle
      state.currentPending = true
      saveState()

      if let staleBundle {
        deleteBundleDirectory(for: staleBundle)
      }

      activatePendingBundleIfPossible()
    } catch {
      try? fileManager.removeItem(at: extractedURL)
      try? fileManager.removeItem(at: destinationURL)
      throw error
    }
  }

  private func extractArchive(at archiveURL: URL, to destinationURL: URL) throws {
    guard
      SSZipArchive.unzipFile(
        atPath: archiveURL.path,
        toDestination: destinationURL.path
      )
    else {
      throw OtaError.invalidArchive("Unable to extract zip archive")
    }
  }

  // Activation is safe to call often; it only does work when there is a pending bundle.
  private func activatePendingBundleIfPossible() {
    guard state.currentPending, let pendingBundle = state.current else {
      return
    }

    guard activatingBundleVersion != pendingBundle.bundleVersion else {
      return
    }

    activatingBundleVersion = pendingBundle.bundleVersion
    log("Reloading React Native to activate OTA bundle \(pendingBundle.bundleVersion)")
    reload(bundleURL: URL(fileURLWithPath: pendingBundle.bundlePath))
  }

  private func rollbackPendingBundle() {
    log("Rolling back pending OTA bundle \(state.current?.bundleVersion ?? "unknown")")

    if let failedBundle = state.current {
      deleteBundleDirectory(for: failedBundle)
    }

    state.current = state.previous
    state.previous = nil
    state.currentPending = false
    activatingBundleVersion = nil
    saveState()
  }

  private func confirmPendingBundle() {
    guard state.currentPending, let currentBundle = state.current else {
      return
    }

    state.currentPending = false
    activatingBundleVersion = nil
    saveState()
    log("Confirmed OTA bundle \(currentBundle.bundleVersion)")
  }

  private func sanitizeState() {
    state.current = sanitized(record: state.current)
    state.previous = sanitized(record: state.previous)
  }

  private func sanitized(record: BundleRecord?) -> BundleRecord? {
    guard let record else {
      return nil
    }

    // Stored state is treated as untrusted because old app versions or manual edits may leave
    // missing files behind.
    guard isUsable(record: record) else {
      deleteBundleDirectory(for: record)
      return nil
    }

    return record
  }

  private func isUsable(record: BundleRecord) -> Bool {
    var isDirectory: ObjCBool = false
    let hasPackageRoot = FileManager.default.fileExists(
      atPath: record.packageRootPath,
      isDirectory: &isDirectory
    )
    let hasBundle = FileManager.default.fileExists(atPath: record.bundlePath)

    return hasPackageRoot && isDirectory.boolValue && hasBundle
  }

  private func loadState() -> PersistedState {
    let data =
      userDefaults.data(forKey: defaultsKey)
      ?? userDefaults.data(forKey: oldDefaultsKey)

    guard let data else {
      return PersistedState()
    }

    do {
      return try JSONDecoder().decode(PersistedState.self, from: data)
    } catch {
      log("Failed to decode OTA state: \(error.localizedDescription)")
      return PersistedState()
    }
  }

  private func saveState() {
    do {
      let data = try JSONEncoder().encode(state)
      userDefaults.set(data, forKey: defaultsKey)
      userDefaults.removeObject(forKey: oldDefaultsKey)
      log(
        "Persisted OTA state (current=\(state.current?.bundleVersion ?? "embedded"), previous=\(state.previous?.bundleVersion ?? "none"), pending=\(state.currentPending))"
      )
    } catch {
      log("Failed to persist OTA state: \(error.localizedDescription)")
    }
  }

  private func createStorageDirectoriesIfNeeded() {
    let fileManager = FileManager.default

    do {
      try fileManager.createDirectory(
        at: bundlesRootURL,
        withIntermediateDirectories: true,
        attributes: nil
      )
      try fileManager.createDirectory(
        at: tempRootURL,
        withIntermediateDirectories: true,
        attributes: nil
      )
    } catch {
      log("Failed to create OTA storage directories: \(error.localizedDescription)")
    }
  }

  private func deleteBundleDirectory(for record: BundleRecord) {
    do {
      if FileManager.default.fileExists(atPath: record.packageRootPath) {
        try FileManager.default.removeItem(atPath: record.packageRootPath)
      }
    } catch {
      log("Failed to delete bundle \(record.bundleVersion): \(error.localizedDescription)")
    }
  }

  private func reload(bundleURL: URL) {
    DispatchQueue.main.async {
      RCTReloadCommandSetBundleURL(bundleURL)
      RCTTriggerReloadCommandListeners(
        "ReactNativeOta installed \(bundleURL.lastPathComponent)"
      )
    }
  }

  private func completeUpdateCheck() {
    queue.async {
      self.completeUpdateCheckNow()
    }
  }

  private func completeUpdateCheckNow() {
    isCheckingForUpdate = false
  }

  private func parseBundleVersionValue(_ value: Any?) -> Int? {
    if let number = value as? NSNumber {
      let integerValue = number.int64Value
      return number.doubleValue == Double(integerValue) && integerValue >= 0
        ? Int(exactly: integerValue)
        : nil
    }

    if let string = value as? String {
      let normalizedValue = string.trimmingCharacters(in: .whitespacesAndNewlines)
      guard
        !normalizedValue.isEmpty,
        normalizedValue.allSatisfy(\.isASCIIWholeNumber),
        let parsedValue = Int(normalizedValue),
        parsedValue >= 0
      else {
        return nil
      }

      return parsedValue
    }

    return nil
  }

  private func safePathComponent(_ value: String) -> String {
    value.replacingOccurrences(
      of: #"[^A-Za-z0-9._-]+"#,
      with: "_",
      options: .regularExpression
    )
  }

  private func log(_ message: String) {
    NSLog("[ReactNativeOta] %@", message)
  }
}

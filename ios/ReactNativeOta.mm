#import "ReactNativeOta.h"
#if __has_include(<ReactNativeOta/ReactNativeOta-Swift.h>)
#import <ReactNativeOta/ReactNativeOta-Swift.h>
#else
#import "ReactNativeOta-Swift.h"
#endif

@implementation ReactNativeOta
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<facebook::react::NativeReactNativeOtaSpecJSI>(params);
}

+ (NSString *)moduleName
{
  return @"ReactNativeOta";
}

+ (NSURL * _Nullable)bundleURL
{
  return [[RNOtaManager sharedManager] bundleURL];
}

+ (void)initialize
{
  [[RNOtaManager sharedManager] initialize];
}

@end

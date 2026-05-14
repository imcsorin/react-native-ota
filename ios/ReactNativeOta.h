#import <ReactNativeOtaSpec/ReactNativeOtaSpec.h>

NS_ASSUME_NONNULL_BEGIN

@interface ReactNativeOta : NSObject <NativeReactNativeOtaSpec>

+ (NSURL * _Nullable)bundleURL;
+ (void)initialize;

@end

NS_ASSUME_NONNULL_END

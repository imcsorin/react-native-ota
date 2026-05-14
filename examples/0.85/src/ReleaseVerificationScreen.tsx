import { useEffect, useState, type ReactNode } from 'react';
import {
  Image,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import VerificationSvg from './assets/verification-badge.svg';

type AssetStatus = 'pending' | 'loaded' | 'failed';

const screenBackgroundColor = '#f3efe5';
const localPngSource = require('./assets/verification-pass.png');
const missingImageSource = {
  uri: 'file:///verification-assets/missing-image.png',
};

export default function ReleaseVerificationScreen({
  bundleLabel,
  expectedScenario,
}: {
  bundleLabel: string;
  expectedScenario: string;
}) {
  const [pngStatus, setPngStatus] = useState<AssetStatus>('pending');
  const [svgStatus, setSvgStatus] = useState<AssetStatus>('pending');
  const [missingImageStatus, setMissingImageStatus] =
    useState<AssetStatus>('pending');

  useEffect(() => {
    const resolvedAsset = Image.resolveAssetSource(localPngSource);

    if (!resolvedAsset?.uri) {
      setPngStatus('failed');
    }
  }, []);

  const overallStatus =
    pngStatus === 'loaded' &&
    svgStatus === 'loaded' &&
    missingImageStatus === 'failed'
      ? 'PASS'
      : pngStatus === 'failed' || svgStatus === 'failed'
        ? 'FAIL'
        : 'RUNNING';

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar
        barStyle="dark-content"
        backgroundColor={screenBackgroundColor}
      />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>
            Release Verification
          </Text>
          <Text style={styles.subtitle}>
            Agent Device reads this screen to confirm the release build and
            bundled assets are healthy.
          </Text>
        </View>

        <Card>
          <Row label="Bundle label" value={bundleLabel} />
          <Row label="Expected scenario" value={expectedScenario} />
          <Row label="Overall" value={overallStatus} status={overallStatus} />
        </Card>

        <Card>
          <Text style={styles.sectionTitle}>Local PNG asset</Text>
          <Text style={styles.helperText}>
            Bundled through Metro with a static require.
          </Text>
          <Image
            source={localPngSource}
            onLoad={() => setPngStatus('loaded')}
            onError={() => setPngStatus('failed')}
            style={styles.previewImage}
            accessibilityLabel="Verification PNG preview"
          />
          <Row label="PNG asset" value={pngStatus} status={pngStatus} />
        </Card>

        <Card>
          <Text style={styles.sectionTitle}>Local SVG asset</Text>
          <Text style={styles.helperText}>
            Imported as a local component to match the app asset pipeline.
          </Text>
          <View
            style={styles.svgFrame}
            onLayout={() => {
              setSvgStatus((currentStatus) =>
                currentStatus === 'pending' ? 'loaded' : currentStatus
              );
            }}
          >
            <VerificationSvg
              width={96}
              height={96}
              accessibilityLabel="Verification SVG preview"
            />
          </View>
          <Row label="SVG asset" value={svgStatus} status={svgStatus} />
        </Card>

        <Card>
          <Text style={styles.sectionTitle}>Negative control</Text>
          <Text style={styles.helperText}>
            This intentionally points at a missing file so the failure path is
            visible to automation.
          </Text>
          <Image
            source={missingImageSource}
            onLoad={() => setMissingImageStatus('loaded')}
            onError={() => setMissingImageStatus('failed')}
            style={styles.previewImage}
            accessibilityLabel="Missing image preview"
          />
          <Row
            label="Broken asset"
            value={missingImageStatus}
            status={missingImageStatus}
          />
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

function Row({
  label,
  value,
  status,
}: {
  label: string;
  value: string;
  status?: string;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text
        style={[
          styles.rowValue,
          status === 'loaded' && styles.loadedText,
          status === 'failed' && styles.failedText,
          status === 'PASS' && styles.loadedText,
          status === 'FAIL' && styles.failedText,
        ]}
      >
        {`${label}: ${value}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: screenBackgroundColor,
  },
  content: {
    padding: 20,
    gap: 16,
  },
  header: {
    gap: 8,
    paddingVertical: 8,
  },
  title: {
    color: '#1b1f18',
    fontSize: 32,
    fontWeight: '700',
  },
  subtitle: {
    color: '#43503d',
    fontSize: 16,
    lineHeight: 22,
  },
  card: {
    backgroundColor: '#fffdf7',
    borderColor: '#d9d1bf',
    borderRadius: 16,
    borderWidth: 1,
    gap: 10,
    padding: 16,
  },
  sectionTitle: {
    color: '#1b1f18',
    fontSize: 20,
    fontWeight: '700',
  },
  helperText: {
    color: '#53614d',
    fontSize: 14,
    lineHeight: 20,
  },
  previewImage: {
    alignSelf: 'flex-start',
    backgroundColor: '#ebe3cf',
    borderRadius: 12,
    height: 96,
    width: 96,
  },
  svgFrame: {
    alignSelf: 'flex-start',
    alignItems: 'center',
    backgroundColor: '#ebe3cf',
    borderRadius: 12,
    justifyContent: 'center',
    minHeight: 96,
    minWidth: 96,
    padding: 8,
  },
  row: {
    gap: 4,
  },
  rowLabel: {
    color: '#6b745f',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  rowValue: {
    color: '#1b1f18',
    fontSize: 17,
    fontWeight: '600',
  },
  loadedText: {
    color: '#24613d',
  },
  failedText: {
    color: '#9f2f26',
  },
});

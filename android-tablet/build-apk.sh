#!/usr/bin/env bash
# Build a signed tablet APK with the installed Android SDK.
# Usage: bash android-tablet/build-apk.sh
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")" && pwd)"
SDK="${ANDROID_SDK_ROOT:-${LOCALAPPDATA:-$HOME/AppData/Local}/Android/Sdk}"
if command -v cygpath >/dev/null 2>&1; then
  SDK="$(cygpath -u "$SDK")"
fi

BUILD_TOOLS="$SDK/build-tools/34.0.0"
ANDROID_JAR="$SDK/platforms/android-34/android.jar"
BUILD="$PROJECT/build"
KEYSTORE="$PROJECT/tablet-release.jks"
KEY_ALIAS="tablet"
KEY_PASS="thinkkk-tablet"
OUTPUT="$BUILD/huanyihuan-tablet.apk"

for tool in aapt2 d8.bat zipalign.exe apksigner.bat; do
  if [ ! -e "$BUILD_TOOLS/$tool" ]; then
    echo "缺少 $BUILD_TOOLS/$tool，请先安装 build-tools;34.0.0" >&2
    exit 1
  fi
done
if [ ! -f "$ANDROID_JAR" ]; then
  echo "缺少 $ANDROID_JAR，请先安装 platforms;android-34" >&2
  exit 1
fi

rm -rf "$BUILD"
mkdir -p "$BUILD/classes" "$BUILD/dex" "$BUILD/gen"

echo "[1/6] 编译资源"
"$BUILD_TOOLS/aapt2.exe" compile --dir "$PROJECT/res" -o "$BUILD/res.zip"

echo "[2/6] 链接清单与资源"
"$BUILD_TOOLS/aapt2.exe" link \
  -o "$BUILD/base.apk" \
  -I "$ANDROID_JAR" \
  --manifest "$PROJECT/AndroidManifest.xml" \
  "$BUILD/res.zip" \
  --java "$BUILD/gen" \
  --min-sdk-version 24 \
  --target-sdk-version 34 \
  --version-code 1 \
  --version-name 1.0

echo "[3/6] 编译 Java"
find "$PROJECT/src" "$BUILD/gen" -name '*.java' | while IFS= read -r file; do
  printf '"%s"\n' "$(cygpath -m "$file")"
done > "$BUILD/sources.txt"
javac --release 8 -encoding UTF-8 \
  -classpath "$ANDROID_JAR" \
  -d "$BUILD/classes" \
  @"$BUILD/sources.txt"

echo "[4/6] 转换 dex"
find "$BUILD/classes" -name '*.class' | while IFS= read -r file; do
  printf '%s\n' "$(cygpath -m "$file")"
done > "$BUILD/classes.txt"
"$BUILD_TOOLS/d8.bat" --release --lib "$ANDROID_JAR" --min-api 24 \
  --output "$BUILD/dex" @"$BUILD/classes.txt"
(
  cd "$BUILD/dex"
  "$JAVA_HOME/bin/jar" uf "$BUILD/base.apk" classes.dex
)

echo "[5/6] 对齐"
"$BUILD_TOOLS/zipalign.exe" -f 4 "$BUILD/base.apk" "$BUILD/aligned.apk"

echo "[6/6] 签名"
if [ ! -f "$KEYSTORE" ]; then
  "$JAVA_HOME/bin/keytool" -genkeypair \
    -keystore "$KEYSTORE" \
    -alias "$KEY_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KEY_PASS" -keypass "$KEY_PASS" \
    -dname "CN=Huanyihuan Tablet, OU=Personal, O=Huanyihuan, L=Local, S=Local, C=CN"
fi
"$BUILD_TOOLS/apksigner.bat" sign \
  --ks "$KEYSTORE" \
  --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "pass:$KEY_PASS" \
  --key-pass "pass:$KEY_PASS" \
  --out "$OUTPUT" \
  "$BUILD/aligned.apk"
"$BUILD_TOOLS/apksigner.bat" verify --print-certs "$OUTPUT" | head -3

echo "APK: $OUTPUT"
ls -lh "$OUTPUT"
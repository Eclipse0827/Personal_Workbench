# 可执行产物

这个目录里的安装包体积太大（合计约 290 MB），超过了 Git 仓库能承受的范围
（GitHub 单文件上限 100 MB），所以**不进版本库**，只随参赛压缩包提交。

本目录在本地应当有这三个文件：

| 文件 | 大小 | 说明 |
|---|---|---|
| `缓一缓-2.0.0-便携版.exe` | 107 MB | 双击即用，不写注册表 |
| `缓一缓-2.0.0-安装版.exe` | 118 MB | NSIS 安装，可选目录、建快捷方式 |
| `缓一缓-2.0.0-安卓版.apk` | 65 MB | `arm64-v8a`，Android 8.0 及以上 |

源码 zip 同样不进版本库：仓库里本来就是源码，再放一份压缩包只会重复。

## 怎么重新构建

```bash
npm install                     # 依赖
npm run dist                    # 出 Windows 便携版 + 安装版
npm run dist:android            # 出 Android APK
```

构建需要本机的安卓签名文件 `mobile/keystore/release.keystore` 与
`mobile/keystore.properties`，这两样出于安全考虑也不进版本库。
没有签名文件时只能出未签名的调试包。

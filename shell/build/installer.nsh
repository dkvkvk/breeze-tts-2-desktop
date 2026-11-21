; Breeze TTS 2 安装器定制
; 1) 默认目录 D:\BreezeTTS2（无空格）
; 2) 安装子目录名统一为 BreezeTTS2，不带空格
; 3) 用户只选到盘符（D: 或 D:\）时，目录页当场补成 D:\BreezeTTS2 并写回输入框

!include "LogicLib.nsh"

; electron-builder 用命令行 /D 传 APP_FILENAME；这里改掉，
; 让它在“只选了盘符”时补的子目录也不带空格
!undef APP_FILENAME
!define APP_FILENAME "BreezeTTS2"

!macro preInit
  StrCpy $INSTDIR "D:\BreezeTTS2"
!macroend

!macro customInit
  ReadRegStr $R0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R0 != ""
    StrCpy $INSTDIR $R0
  ${ElseIf} ${FileExists} "D:\*.*"
    StrCpy $INSTDIR "D:\BreezeTTS2"
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
Var UpgradeSource
Var UpgradeBackup

!macro VoiceTrackStage ITEM
  ${If} ${FileExists} "$UpgradeSource\${ITEM}"
    ${If} ${FileExists} "$UpgradeBackup\${ITEM}"
      Goto protect_failed
    ${EndIf}
    ClearErrors
    Rename "$UpgradeSource\${ITEM}" "$UpgradeBackup\${ITEM}"
    IfErrors protect_failed
  ${EndIf}
!macroend

!macro VoiceTrackRestore ITEM TARGET
  ${If} ${FileExists} "$UpgradeBackup\${ITEM}"
    ${If} ${FileExists} "${TARGET}\${ITEM}"
      Goto restore_failed
    ${EndIf}
    ClearErrors
    Rename "$UpgradeBackup\${ITEM}" "${TARGET}\${ITEM}"
    IfErrors restore_failed
  ${EndIf}
!macroend

!macro customHeader
  ; This hidden section runs only after installation is chosen, before the old uninstaller.
  Section "-Protect voice and model data"
    ReadRegStr $UpgradeSource SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $UpgradeSource == ""
      StrCpy $UpgradeSource $INSTDIR
    ${EndIf}
    GetFullPathName $UpgradeSource "$UpgradeSource\."
    StrCpy $UpgradeBackup "$UpgradeSource.voicetrack-backup"

    ${If} ${FileExists} "$UpgradeBackup\*.*"
      ${IfNot} ${FileExists} "$UpgradeBackup\.voicetrack-upgrade"
        MessageBox MB_OK|MB_ICONSTOP "备份位置已被占用：$UpgradeBackup" /SD IDOK
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${ElseIf} ${FileExists} "$UpgradeSource\Breeze TTS 2.exe"
    ${OrIf} ${FileExists} "$UpgradeSource\${APP_EXECUTABLE_FILENAME}"
      ClearErrors
      CreateDirectory "$UpgradeBackup"
      IfErrors protect_failed
      FileOpen $R0 "$UpgradeBackup\.voicetrack-upgrade" w
      IfErrors protect_failed
      FileClose $R0
    ${Else}
      StrCpy $UpgradeBackup ""
      Goto protect_done
    ${EndIf}

    !insertmacro VoiceTrackStage "models"
    !insertmacro VoiceTrackStage "voices"
    !insertmacro VoiceTrackStage "design-presets.json"
    !insertmacro VoiceTrackStage "model-path.txt"
    Goto protect_done

    protect_failed:
      MessageBox MB_OK|MB_ICONSTOP "无法保护全部升级数据。请退出旧应用后重试。已暂存的数据可在此找回：$UpgradeBackup" /SD IDOK
      SetErrorLevel 2
      Quit
    protect_done:
  SectionEnd
!macroend

!macro customInstall
  ${If} $UpgradeBackup != ""
    !insertmacro VoiceTrackRestore "models" "$INSTDIR"
    !insertmacro VoiceTrackRestore "voices" "$INSTDIR"
    !insertmacro VoiceTrackRestore "design-presets.json" "$INSTDIR"
    !insertmacro VoiceTrackRestore "model-path.txt" "$INSTDIR"
    Delete "$UpgradeBackup\.voicetrack-upgrade"
    RMDir "$UpgradeBackup"
  ${EndIf}
  Goto restore_done

  restore_failed:
    MessageBox MB_OK|MB_ICONSTOP "安装后未能恢复全部数据。剩余数据仍在：$UpgradeBackup" /SD IDOK
    SetErrorLevel 2
    Quit
  restore_done:
!macroend
!endif

; 目录页每次校验都调用：把盘符根补成完整目录
Function .onVerifyInstDir
  StrLen $R1 "$INSTDIR"
  ${If} $R1 == 2
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
    Call BreezeSyncDirField
  ${ElseIf} $R1 == 3
    StrCpy $R0 "$INSTDIR" 1 -1
    ${If} $R0 == "\"
      StrCpy $INSTDIR "$INSTDIR${APP_FILENAME}"
      Call BreezeSyncDirField
    ${EndIf}
  ${EndIf}
FunctionEnd

; 把 $INSTDIR 写回目录页输入框（MUI2 是 ComboBox + 内嵌 Edit）
Function BreezeSyncDirField
  StrCpy $R3 0
  System::Call 'user32::FindWindowEx(p $HWNDPARENT, p 0, t "ComboBox", p 0) -> p .R2'
  ${If} $R2 != 0
    System::Call 'user32::FindWindowEx(p $R2, p 0, t "Edit", p 0) -> p .R3'
  ${EndIf}
  ${If} $R3 == 0
    System::Call 'user32::FindWindowEx(p $HWNDPARENT, p 0, t "Edit", p 0) -> p .R3'
  ${EndIf}
  ${If} $R3 != 0
    System::Call 'user32::SendMessageW(p $R3, i 12, p 0, w "$INSTDIR")'
  ${EndIf}
FunctionEnd

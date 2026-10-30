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
  StrCpy $INSTDIR "D:\BreezeTTS2"
!macroend

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

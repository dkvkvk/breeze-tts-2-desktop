; Breeze TTS 2 安装器定制
; 1) 默认装到 D 盘
; 2) 目录页只选了盘符（D:\）时，立刻补上应用名并写回输入框

!include "LogicLib.nsh"

!macro preInit
  StrCpy $INSTDIR "D:\Breeze TTS 2"
!macroend

!macro customInit
  StrCpy $INSTDIR "D:\Breeze TTS 2"
!macroend

Function .onVerifyInstDir
  StrLen $R1 "$INSTDIR"
  StrCpy $R0 "$INSTDIR" "" -1
  ${If} $R1 == 3
    ${If} $R0 == "\"
      StrCpy $INSTDIR "$INSTDIR${APP_FILENAME}"
      System::Call 'user32::FindWindowEx(p $HWNDPARENT, p 0, t "Edit", p 0) -> p .R2'
      ${If} $R2 != 0
        System::Call 'user32::SendMessageA(p $R2, i 12, p 0, t "$INSTDIR")'
      ${EndIf}
    ${EndIf}
  ${EndIf}
FunctionEnd

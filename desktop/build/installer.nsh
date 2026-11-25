; Registers hindsight:// links when the app is installed and removes them when it is uninstalled
; (electron-builder's NSIS target registers file associations but not protocols). The app also
; registers itself each time it starts, in case another copy took the links over.
!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\hindsight" "" "URL:Hindsight"
  WriteRegStr SHELL_CONTEXT "Software\Classes\hindsight" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\hindsight\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\hindsight\shell\open\command" "" '"$appExe" "%1"'
!macroend

!macro customUnInstall
  ; An update runs the old uninstaller first; the new version registers the links again.
  ${ifNot} ${isUpdated}
    DeleteRegKey SHELL_CONTEXT "Software\Classes\hindsight"
  ${endIf}
!macroend

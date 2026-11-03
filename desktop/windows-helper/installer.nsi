Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "${PAYLOAD_INCLUDE}"

Name "Concept Graph Helper"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Concept Graph Helper"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 32
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "${PRODUCT_VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "Concept Graph Helper"
VIAddVersionKey /LANG=1033 "CompanyName" "knifest-studio"
VIAddVersionKey /LANG=1033 "FileDescription" "Concept Graph Helper Setup"
VIAddVersionKey /LANG=1033 "FileVersion" "${HELPER_VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "MIT License"

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ConceptGraphHelper"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Launch Concept Graph Helper"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchHelper
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Var UserSid
Var HelperMutex

!macro HelperFunctions PREFIX GUIEND
Function ${PREFIX}ReserveHelper
  SetShellVarContext current
  SetRegView 64
  StrCpy $UserSid ""
  System::Call 'advapi32::OpenProcessToken(p -1, i 0x8, *p .r0) i .r1'
  ${If} $1 <> 0
    System::Alloc 1024
    Pop $2
    ${If} $2 <> 0
      System::Call 'advapi32::GetTokenInformation(p r0, i 1, p r2, i 1024, *i .r3) i .r1'
      ${If} $1 <> 0
        System::Call '*$2(p .r3)'
        System::Call 'advapi32::ConvertSidToStringSidW(p r3, *p .r4) i .r1'
        ${If} $1 <> 0
          System::Call 'kernel32::lstrcpynW(w .r5, p r4, i ${NSIS_MAX_STRLEN})'
          StrCpy $UserSid $5
          System::Call 'kernel32::LocalFree(p r4)'
        ${EndIf}
      ${EndIf}
      System::Free $2
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r0)'
  ${EndIf}
  ${If} $UserSid == ""
    MessageBox MB_OK|MB_ICONSTOP "Could not identify the current Windows user. Setup cannot continue."
    Abort
  ${EndIf}
  retry:
    System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\ConceptGraph.Helper.$UserSid") p .r0 ?e'
    Pop $1
    ${If} $0 == 0
      MessageBox MB_OK|MB_ICONSTOP "Could not check whether the helper is running. Close the helper and any other setup window, then try again."
      Abort
    ${EndIf}
    ${If} $1 == 183
      System::Call 'kernel32::CloseHandle(p r0)'
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Close Concept Graph Helper (or the other setup window), then click Retry. Any active generation must finish or be stopped first." /SD IDCANCEL IDRETRY retry
      Abort
    ${EndIf}
    StrCpy $HelperMutex $0
FunctionEnd

Function ${GUIEND}
  ${If} $HelperMutex <> 0
    System::Call 'kernel32::CloseHandle(p $HelperMutex)'
    StrCpy $HelperMutex 0
  ${EndIf}
FunctionEnd
!macroend
!insertmacro HelperFunctions "" ".onGUIEnd"
!insertmacro HelperFunctions "un." "un.onGUIEnd"

Function .onInit
  StrCpy $HelperMutex 0
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "Concept Graph Helper requires Windows 10 or Windows 11."
    Abort
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "Concept Graph Helper requires 64-bit Windows 10 or Windows 11."
    Abort
  ${EndIf}
  SetRegView 64
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full" "Release"
  ${If} $0 < 528040
    MessageBox MB_OK|MB_ICONSTOP "Install .NET Framework 4.8 or later, then run this installer again. It is included with Windows 10 version 1903 and later and Windows 11."
    Abort
  ${EndIf}
  Call ReserveHelper
FunctionEnd

Function un.onInit
  StrCpy $HelperMutex 0
  Call un.ReserveHelper
FunctionEnd

Function LaunchHelper
  System::Call 'kernel32::CloseHandle(p $HelperMutex)'
  StrCpy $HelperMutex 0
  Exec '"$INSTDIR\Concept Graph Helper.exe"'
FunctionEnd

Section "Concept Graph Helper"
  SetOverwrite on
  !insertmacro InstallPayload
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\Concept Graph Helper.lnk" "$INSTDIR\Concept Graph Helper.exe"
  CreateShortcut "$DESKTOP\Concept Graph Helper.lnk" "$INSTDIR\Concept Graph Helper.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "Concept Graph Helper"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${HELPER_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "knifest-studio"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" '"$INSTDIR\Concept Graph Helper.exe",0'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" ${HELPER_SIZE_KIB}
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  !insertmacro RemovePayload
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\Concept Graph Helper.lnk"
  Delete "$DESKTOP\Concept Graph Helper.lnk"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd

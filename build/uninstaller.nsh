!macro customUnInstall
  MessageBox MB_YESNO "¿Deseas eliminar también tus datos (base de datos, préstamos, configuración)?$\n$\nSi eliges NO, tus datos se conservarán en:$\n$APPDATA\${APP_FILENAME}$\n$\nPodrás reutilizarlos si reinstalas la aplicación." IDYES removeData IDNO keepData
  removeData:
    RMDir /r "$APPDATA\${APP_FILENAME}"
    Goto done
  keepData:
    ; No hacer nada, datos conservados
  done:
!macroend

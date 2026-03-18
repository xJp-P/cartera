!macro customUnInstall
  MessageBox MB_YESNO "¿Deseas eliminar también tus datos (base de datos, préstamos, configuración)?$\n$\nSi eliges NO, tus datos se conservarán en:$\n$APPDATA\Cartera de Prestamos$\n$\nPodrás reutilizarlos si reinstalas la aplicación." IDYES removeData IDNO keepData
  removeData:
    RMDir /r "$APPDATA\Cartera de Prestamos"
    RMDir /r "$APPDATA\cartera-prestamos"
    Goto done
  keepData:
    ; No hacer nada, datos conservados
  done:
!macroend

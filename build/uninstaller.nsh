!macro customUnInstall
  ; Si es una actualización silenciosa (--updated flag), no preguntar nada
  ${IfNot} ${Silent}
    MessageBox MB_YESNO "¿Deseas eliminar también tus datos (base de datos, préstamos, configuración)?$\n$\nSi eliges NO, tus datos se conservarán en:$\n$APPDATA\cartera-prestamos$\n$\nPodrás reutilizarlos si reinstalas la aplicación." IDYES removeData IDNO keepData
    removeData:
      RMDir /r "$APPDATA\cartera-prestamos"
      RMDir /r "$APPDATA\Cartera de Prestamos"
      Goto done
    keepData:
      ; Datos conservados
    done:
  ${EndIf}
!macroend

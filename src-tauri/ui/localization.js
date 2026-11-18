const nativeSpanish = {
  "Preparing the studio…": "Preparando el estudio…",
  "Starting VideoGen": "Iniciando VideoGen",
  "VideoGen Settings": "Ajustes de VideoGen",
  "Settings": "Ajustes",
  "Keys are stored securely on this device. The fields never show saved keys.": "Las claves se guardan en el almacén seguro del sistema. Los campos nunca muestran las claves guardadas.",
  "Save changes": "Guardar cambios",
  "Import keys from an .env file": "Importar claves de .env",
  "Restart VideoGen to apply changes. Save any edits and let active renders finish first.": "Reinicia VideoGen para aplicar los cambios. Guarda antes cualquier edición y espera a que terminen los renders en curso.",
  "Restart VideoGen": "Reiniciar VideoGen",
  "Not configured": "Sin configurar",
  "Configured · enter a new key to replace it": "Configurada · escribe para sustituirla",
  "Remove key": "Eliminar clave",
  "Remove the {0} key?": "¿Eliminar la clave de {0}?",
  "Key removed. Restart to apply the change.": "Clave eliminada. Reinicia para aplicar el cambio.",
  "Could not remove the key.": "No se pudo eliminar la clave.",
  "Changes saved. Restart to apply them.": "Cambios guardados. Reinicia para aplicarlos.",
  "Could not save all changes. Try again.": "No se pudieron guardar todos los cambios. Vuelve a intentarlo.",
  "Restart VideoGen? Active jobs will stop.": "¿Reiniciar VideoGen? Se detendrán los trabajos en curso.",
  "Imported {0} keys into secure storage. Restart to apply them.": "Se importaron {0} claves al almacén seguro. Reinicia para aplicarlas.",
  "No keys were imported.": "No se importó ninguna clave.",
  "Could not import the keys.": "No se pudieron importar las claves.",
  "Could not access secure storage.": "No se puede acceder al almacén seguro."
};

function nativeText(english, value) {
  const message = document.documentElement.lang === "es" ? nativeSpanish[english] ?? english : english;
  return value === undefined ? message : message.replace("{0}", () => String(value));
}

const nativeLanguageReady = window.__TAURI__.core.invoke("app_language").catch(() => navigator.language.split("-")[0]).then((locale) => {
  document.documentElement.lang = locale === "es" ? "es" : "en";
  document.querySelectorAll("[data-localize]").forEach((element) => {
    element.textContent = nativeText(element.textContent);
  });
  document.querySelectorAll("[data-localize-label]").forEach((element) => {
    element.setAttribute("aria-label", nativeText(element.getAttribute("aria-label")));
  });
});

/** Estado compartido por las server actions de formularios (sin `server-only`: lo importan también componentes cliente). */
export type ActionState = {
  error?: string;
  ok?: string;
  /** Datos de una sola vez para mostrar tras la acción (ej. contraseña temporal, enlace de restablecimiento). */
  data?: Record<string, string>;
};

export const idle: ActionState = {};

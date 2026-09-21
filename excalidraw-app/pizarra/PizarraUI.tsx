import { Sidebar } from "@excalidraw/excalidraw";
import ConfirmDialog from "@excalidraw/excalidraw/components/ConfirmDialog";
import {
  chevronRight,
  LibraryIcon,
  pencilIcon,
  PlusIcon,
  TrashIcon,
} from "@excalidraw/excalidraw/components/icons";
import clsx from "clsx";
import { useEffect, useState } from "react";

import { useAtomValue } from "../app-jotai";

import { ancestrosDe, descendientesDe, hijosDe, rutaDe } from "./api";
import { pizarra, pizarraAtom, SIDEBAR_PIZARRA } from "./pizarra";

import "./pizarra.scss";

import type { EstadoGuardado, Hoja, Proyecto } from "./pizarra";

const TEXTO_GUARDADO: Record<EstadoGuardado, string> = {
  cargando: "Cargando…",
  guardado: "Guardado en pc3",
  pendiente: "Cambios sin guardar…",
  guardando: "Guardando…",
  error: "No se pudo guardar",
};

/** Input que confirma con Enter o al salir, y cancela con Escape. */
const CampoNombre = ({
  inicial = "",
  placeholder,
  onListo,
}: {
  inicial?: string;
  placeholder: string;
  onListo: (nombre: string | null) => void;
}) => {
  const [valor, setValor] = useState(inicial);
  const terminar = (confirmar: boolean) => {
    const nombre = valor.trim();
    onListo(confirmar && nombre && nombre !== inicial ? nombre : null);
  };
  return (
    <input
      className="pizarra-campo"
      autoFocus
      value={valor}
      maxLength={80}
      placeholder={placeholder}
      onChange={(event) => setValor(event.target.value)}
      onFocus={(event) => event.target.select()}
      onBlur={() => terminar(true)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          terminar(true);
        } else if (event.key === "Escape") {
          terminar(false);
        }
      }}
    />
  );
};

const BotonIcono = ({
  titulo,
  icono,
  onClick,
  peligro = false,
}: {
  titulo: string;
  icono: React.ReactNode;
  onClick: () => void;
  peligro?: boolean;
}) => (
  <button
    type="button"
    className={clsx("pizarra-icono", { "pizarra-icono--peligro": peligro })}
    title={titulo}
    aria-label={titulo}
    onClick={(event) => {
      event.stopPropagation();
      onClick();
    }}
  >
    {icono}
  </button>
);

const EstadoDeGuardado = () => {
  const { guardado, error } = useAtomValue(pizarraAtom);
  return (
    <div
      className={clsx("pizarra-estado", `pizarra-estado--${guardado}`)}
      title={error ?? undefined}
    >
      <span className="pizarra-estado__punto" />
      {guardado === "error" && error ? error : TEXTO_GUARDADO[guardado]}
    </div>
  );
};

type Borrado =
  | { tipo: "proyecto"; proyecto: Proyecto }
  | { tipo: "hoja"; hoja: Hoja };

/**
 * Una hoja del árbol: su fila + (si está expandida) sus sub-hojas, recursivo.
 * El nivel de anidamiento se pasa como variable CSS para la indentación.
 */
const NodoHoja = ({
  hoja,
  hojas,
  nivel,
  expandido,
  onAlternar,
  onExpandir,
  onBorrar,
}: {
  hoja: Hoja;
  hojas: Hoja[];
  nivel: number;
  expandido: Set<string>;
  onAlternar: (id: string) => void;
  onExpandir: (id: string) => void;
  onBorrar: (hoja: Hoja) => void;
}) => {
  const { proyectoId, hojaId } = useAtomValue(pizarraAtom);
  const [editando, setEditando] = useState(false);
  const [creandoHija, setCreandoHija] = useState(false);
  const hijos = hijosDe(hojas, hoja.id);
  const hermanas = hijosDe(hojas, hoja.padre);
  const posicion = hermanas.findIndex((x) => x.id === hoja.id);
  const primera = posicion === 0;
  const ultima = posicion === hermanas.length - 1;
  const abierta = expandido.has(hoja.id);

  return (
    <div className="pizarra-nodo">
      {editando ? (
        <div
          className="pizarra-fila pizarra-fila--hoja"
          style={{ "--pizarra-nivel": nivel } as React.CSSProperties}
        >
          <span className="pizarra-chevron pizarra-chevron--espaciador" />
          <CampoNombre
            inicial={hoja.nombre}
            placeholder="Nombre de la hoja"
            onListo={(nombre) => {
              setEditando(false);
              if (nombre) {
                pizarra.renombrarHoja(hoja.id, nombre);
              }
            }}
          />
        </div>
      ) : (
        <div
          className={clsx("pizarra-fila pizarra-fila--hoja", {
            "pizarra-fila--activa": hoja.id === hojaId,
          })}
          style={{ "--pizarra-nivel": nivel } as React.CSSProperties}
          onClick={() => pizarra.abrirHoja(proyectoId!, hoja.id)}
          onDoubleClick={() => setEditando(true)}
        >
          {hijos.length ? (
            <button
              type="button"
              className={clsx("pizarra-chevron", {
                "pizarra-chevron--abierto": abierta,
              })}
              title={abierta ? "Contraer sub-hojas" : "Expandir sub-hojas"}
              aria-label={abierta ? "Contraer sub-hojas" : "Expandir sub-hojas"}
              onClick={(event) => {
                event.stopPropagation();
                onAlternar(hoja.id);
              }}
            >
              {chevronRight}
            </button>
          ) : (
            <span className="pizarra-chevron pizarra-chevron--espaciador" />
          )}
          <span className="pizarra-fila__nombre">{hoja.nombre}</span>
          <span className="pizarra-fila__acciones">
            {!primera && (
              <BotonIcono
                titulo="Subir"
                icono="↑"
                onClick={() => pizarra.moverHoja(hoja.id, -1)}
              />
            )}
            {!ultima && (
              <BotonIcono
                titulo="Bajar"
                icono="↓"
                onClick={() => pizarra.moverHoja(hoja.id, 1)}
              />
            )}
            <BotonIcono
              titulo="Agregar sub-hoja"
              icono={PlusIcon}
              onClick={() => {
                onExpandir(hoja.id);
                setCreandoHija(true);
              }}
            />
            <BotonIcono
              titulo="Renombrar"
              icono={pencilIcon}
              onClick={() => setEditando(true)}
            />
            {hojas.length > 1 && (
              <BotonIcono
                titulo="Borrar hoja"
                icono={TrashIcon}
                peligro
                onClick={() => onBorrar(hoja)}
              />
            )}
          </span>
        </div>
      )}
      {(creandoHija || (abierta && hijos.length > 0)) && (
        <div className="pizarra-subarbol">
          {creandoHija && (
            <div className="pizarra-nodo pizarra-nodo--borrador">
              <div className="pizarra-fila pizarra-fila--hoja">
                <span className="pizarra-chevron pizarra-chevron--espaciador" />
                <CampoNombre
                  placeholder="Nombre de la sub-hoja"
                  onListo={(nombre) => {
                    setCreandoHija(false);
                    if (nombre) {
                      pizarra.crearHoja(nombre, hoja.id);
                    }
                  }}
                />
              </div>
            </div>
          )}
          {abierta &&
            hijos.map((hijo) => (
              <NodoHoja
                key={hijo.id}
                hoja={hijo}
                hojas={hojas}
                nivel={nivel + 1}
                expandido={expandido}
                onAlternar={onAlternar}
                onExpandir={onExpandir}
                onBorrar={onBorrar}
              />
            ))}
        </div>
      )}
    </div>
  );
};

const FilaProyecto = ({
  proyecto,
  onBorrar,
}: {
  proyecto: Proyecto;
  onBorrar: (borrado: Borrado) => void;
}) => {
  const { proyectoId, hojaId } = useAtomValue(pizarraAtom);
  const [editando, setEditando] = useState(false);
  const [creandoHoja, setCreandoHoja] = useState(false);
  const abierto = proyecto.id === proyectoId;
  const [expandido, setExpandido] = useState<Set<string>>(new Set());

  // al entrar a la hoja (o cambiar de hoja dentro del proyecto), asegura que
  // sus antecesoras estén expandidas para que siempre se vea dónde está
  useEffect(() => {
    if (!abierto || !hojaId) {
      return;
    }
    const cadena = ancestrosDe(proyecto.hojas, hojaId);
    if (cadena.some((id) => !expandido.has(id))) {
      setExpandido((prev) => new Set([...prev, ...cadena]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abierto, hojaId, proyecto.hojas]);

  const alternar = (id: string) =>
    setExpandido((prev) => {
      const siguiente = new Set(prev);
      if (siguiente.has(id)) {
        siguiente.delete(id);
      } else {
        siguiente.add(id);
      }
      return siguiente;
    });
  const expandir = (id: string) =>
    setExpandido((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));

  return (
    <div
      className={clsx("pizarra-proyecto", {
        "pizarra-proyecto--abierto": abierto,
      })}
    >
      {editando ? (
        <div className="pizarra-fila">
          <CampoNombre
            inicial={proyecto.nombre}
            placeholder="Nombre del proyecto"
            onListo={(nombre) => {
              setEditando(false);
              if (nombre) {
                pizarra.renombrarProyecto(proyecto.id, nombre);
              }
            }}
          />
        </div>
      ) : (
        <div
          className="pizarra-fila pizarra-fila--proyecto"
          onClick={() => pizarra.abrirProyecto(proyecto.id)}
          onDoubleClick={() => setEditando(true)}
        >
          <span className="pizarra-fila__nombre">{proyecto.nombre}</span>
          <span className="pizarra-fila__cuenta">{proyecto.hojas.length}</span>
          <span className="pizarra-fila__acciones">
            <BotonIcono
              titulo="Renombrar proyecto"
              icono={pencilIcon}
              onClick={() => setEditando(true)}
            />
            <BotonIcono
              titulo="Borrar proyecto"
              icono={TrashIcon}
              peligro
              onClick={() => onBorrar({ tipo: "proyecto", proyecto })}
            />
          </span>
        </div>
      )}
      {abierto && (
        <div className="pizarra-hojas-lista">
          {hijosDe(proyecto.hojas, null).map((hoja) => (
            <NodoHoja
              key={hoja.id}
              hoja={hoja}
              hojas={proyecto.hojas}
              nivel={0}
              expandido={expandido}
              onAlternar={alternar}
              onExpandir={expandir}
              onBorrar={(hoja) => onBorrar({ tipo: "hoja", hoja })}
            />
          ))}
          {creandoHoja ? (
            <div className="pizarra-fila pizarra-fila--hoja">
              <CampoNombre
                placeholder="Nombre de la hoja"
                onListo={(nombre) => {
                  setCreandoHoja(false);
                  if (nombre) {
                    pizarra.crearHoja(nombre);
                  }
                }}
              />
            </div>
          ) : (
            <button
              type="button"
              className="pizarra-agregar pizarra-agregar--hoja"
              onClick={() => setCreandoHoja(true)}
            >
              {PlusIcon} Nueva hoja
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export const PizarraSidebar = () => {
  const { proyectos } = useAtomValue(pizarraAtom);
  const [creandoProyecto, setCreandoProyecto] = useState(false);
  const [borrado, setBorrado] = useState<Borrado | null>(null);

  return (
    // sin `docked`: la lógica de reservar espacio de canvas al anclar es del
    // sidebar derecho de Excalidraw; este se abre siempre como panel flotante
    // sobre el canvas, desde la izquierda (ver .pizarra-sidebar en el scss)
    <Sidebar name={SIDEBAR_PIZARRA} className="pizarra-sidebar">
      <Sidebar.Header>
        <div className="pizarra-sidebar__titulo">Proyectos</div>
      </Sidebar.Header>
      <div className="pizarra-sidebar__cuerpo">
        {proyectos.map((proyecto) => (
          <FilaProyecto
            key={proyecto.id}
            proyecto={proyecto}
            onBorrar={setBorrado}
          />
        ))}
        {creandoProyecto ? (
          <div className="pizarra-fila">
            <CampoNombre
              placeholder="Nombre del proyecto"
              onListo={(nombre) => {
                setCreandoProyecto(false);
                if (nombre) {
                  pizarra.crearProyecto(nombre);
                }
              }}
            />
          </div>
        ) : (
          <button
            type="button"
            className="pizarra-agregar"
            onClick={() => setCreandoProyecto(true)}
          >
            {PlusIcon} Nuevo proyecto
          </button>
        )}
      </div>
      <div className="pizarra-sidebar__pie">
        <EstadoDeGuardado />
        <div className="pizarra-sidebar__acciones">
          <button
            type="button"
            className="pizarra-salir"
            title="Por si dejaste otra pestaña o dispositivo abierto: los desloguea a todos menos a este, sin tocar tu trabajo acá"
            onClick={() => pizarra.cerrarOtrasSesiones()}
          >
            Cerrar otras sesiones
          </button>
          <button
            type="button"
            className="pizarra-salir"
            onClick={() => pizarra.cerrarSesion()}
          >
            Cerrar sesión
          </button>
        </div>
      </div>
      {borrado && (
        <ConfirmDialog
          title={
            borrado.tipo === "proyecto"
              ? `¿Borrar el proyecto «${borrado.proyecto.nombre}»?`
              : `¿Borrar la hoja «${borrado.hoja.nombre}»?`
          }
          confirmText="Borrar"
          cancelText="Cancelar"
          onCancel={() => setBorrado(null)}
          onConfirm={() => {
            setBorrado(null);
            if (borrado.tipo === "proyecto") {
              pizarra.borrarProyecto(borrado.proyecto.id);
            } else {
              pizarra.borrarHoja(borrado.hoja.id);
            }
          }}
        >
          <p>
            {borrado.tipo === "proyecto"
              ? `Se van a mover a la papelera de pc3 las ${borrado.proyecto.hojas.length} hojas del proyecto.`
              : (() => {
                  const dueño = proyectos.find((p) =>
                    p.hojas.some((h) => h.id === borrado.hoja.id),
                  );
                  const sub = dueño
                    ? descendientesDe(dueño.hojas, borrado.hoja.id).length
                    : 0;
                  return sub
                    ? `Se van a mover a la papelera de pc3 la hoja y sus ${sub} sub-hojas.`
                    : "La hoja se mueve a la papelera de pc3.";
                })()}
          </p>
        </ConfirmDialog>
      )}
    </Sidebar>
  );
};

/** Título fijo arriba a la izquierda; también abre el panel. */
export const PizarraTrigger = ({ compacto }: { compacto: boolean }) => {
  const estado = useAtomValue(pizarraAtom);
  const proyecto = estado.proyectos.find((p) => p.id === estado.proyectoId);
  const ruta =
    proyecto && estado.hojaId ? rutaDe(proyecto.hojas, estado.hojaId) : [];
  const hojaActual = ruta.at(-1);
  const rutaCompleta = [proyecto?.nombre, ...ruta.map((hoja) => hoja.nombre)]
    .filter(Boolean)
    .join(" › ");
  return (
    <Sidebar.Trigger
      name={SIDEBAR_PIZARRA}
      title={
        rutaCompleta
          ? `Abrir proyectos y hojas · ${rutaCompleta}`
          : "Proyectos y hojas"
      }
      icon={LibraryIcon}
      className="pizarra-trigger"
    >
      <span className="pizarra-trigger__texto">
        <span className="pizarra-trigger__hoja">
          {hojaActual?.nombre ?? "…"}
        </span>
        {!compacto && proyecto && hojaActual && (
          <span className="pizarra-trigger__proyecto">
            {" · "}
            {proyecto.nombre}
          </span>
        )}
      </span>
      <span
        className={clsx(
          "pizarra-estado__punto",
          `pizarra-estado--${estado.guardado}`,
        )}
        title={TEXTO_GUARDADO[estado.guardado]}
      />
    </Sidebar.Trigger>
  );
};

/**
 * Ícono arriba a la derecha, un par de segundos, cuando el servidor acaba de
 * fusionar el último guardado con cambios hechos en otro lado (Fase 0) --
 * reemplaza al toast de texto que tapaba el lienzo.
 */
export const PizarraFusionIndicador = () => {
  const { fusionReciente } = useAtomValue(pizarraAtom);
  return (
    <div
      className={clsx("pizarra-fusion", {
        "pizarra-fusion--visible": fusionReciente,
      })}
      title="Se combinó con cambios hechos en otro lugar"
      role="status"
    >
      <svg viewBox="0 0 20 20" width="16" height="16" fill="none">
        <path
          d="M4 8a6 6 0 0 1 10.4-4.1M16 4v3.5h-3.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M16 12a6 6 0 0 1-10.4 4.1M4 16v-3.5h3.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
};

/** Pestañas de hojas en el pie (solo escritorio y tablet). */
export const PizarraHojas = () => {
  const estado = useAtomValue(pizarraAtom);
  const proyecto = estado.proyectos.find((p) => p.id === estado.proyectoId);
  const [editando, setEditando] = useState<string | null>(null);
  const [creando, setCreando] = useState(false);
  if (!proyecto) {
    return null;
  }
  // las pestañas solo muestran las hojas de primer nivel; si la hoja abierta
  // es una sub-hoja, se resalta la pestaña de la que "cuelga"
  const raizActiva = estado.hojaId
    ? rutaDe(proyecto.hojas, estado.hojaId)[0]?.id
    : null;
  return (
    <div className="pizarra-pestanas">
      {hijosDe(proyecto.hojas, null).map((hoja) =>
        editando === hoja.id ? (
          <CampoNombre
            key={hoja.id}
            inicial={hoja.nombre}
            placeholder="Nombre de la hoja"
            onListo={(nombre) => {
              setEditando(null);
              if (nombre) {
                pizarra.renombrarHoja(hoja.id, nombre);
              }
            }}
          />
        ) : (
          <button
            key={hoja.id}
            type="button"
            className={clsx("pizarra-pestana", {
              "pizarra-pestana--activa": hoja.id === raizActiva,
            })}
            title="Doble clic para renombrar"
            onClick={() => pizarra.abrirHoja(proyecto.id, hoja.id)}
            onDoubleClick={() => setEditando(hoja.id)}
          >
            {hoja.nombre}
          </button>
        ),
      )}
      {creando ? (
        <CampoNombre
          placeholder="Nueva hoja"
          onListo={(nombre) => {
            setCreando(false);
            if (nombre) {
              pizarra.crearHoja(nombre);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="pizarra-pestana pizarra-pestana--nueva"
          title="Nueva hoja"
          aria-label="Nueva hoja"
          onClick={() => setCreando(true)}
        >
          {PlusIcon}
        </button>
      )}
      <EstadoDeGuardado />
    </div>
  );
};

/** Pantalla de contraseña: al abrir la pizarra o si la sesión venció. */
export const PizarraLogin = ({ tema }: { tema: "light" | "dark" }) => {
  const { necesitaLogin } = useAtomValue(pizarraAtom);
  const [contrasena, setContrasena] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  if (!necesitaLogin) {
    return null;
  }
  return (
    <div
      className={clsx("pizarra-login", {
        "pizarra-login--oscuro": tema === "dark",
      })}
    >
      <form
        className="pizarra-login__caja"
        onKeyDown={(event) => event.stopPropagation()}
        onSubmit={async (event) => {
          event.preventDefault();
          setEnviando(true);
          setError(null);
          try {
            await pizarra.iniciarSesion(contrasena);
            setContrasena("");
          } catch (error: any) {
            setError(error.message);
          } finally {
            setEnviando(false);
          }
        }}
      >
        <h1>Pizarra</h1>
        <p>Ingresá la contraseña para ver tus proyectos.</p>
        {/* para que el navegador pueda recordar la contraseña */}
        <input
          type="text"
          name="username"
          autoComplete="username"
          value="pizarra"
          readOnly
          hidden
        />
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="Contraseña"
          autoFocus
          value={contrasena}
          onChange={(event) => setContrasena(event.target.value)}
        />
        {error && <div className="pizarra-login__error">{error}</div>}
        <button type="submit" disabled={enviando || !contrasena}>
          {enviando ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </div>
  );
};

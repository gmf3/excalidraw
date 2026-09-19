import { Sidebar } from "@excalidraw/excalidraw";
import ConfirmDialog from "@excalidraw/excalidraw/components/ConfirmDialog";
import {
  LibraryIcon,
  pencilIcon,
  PlusIcon,
  TrashIcon,
} from "@excalidraw/excalidraw/components/icons";
import clsx from "clsx";
import { useState } from "react";

import { useAtomValue } from "../app-jotai";

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

const FilaHoja = ({
  hoja,
  activa,
  primera,
  ultima,
  onBorrar,
}: {
  hoja: Hoja;
  activa: boolean;
  primera: boolean;
  ultima: boolean;
  onBorrar: () => void;
}) => {
  const { proyectoId } = useAtomValue(pizarraAtom);
  const [editando, setEditando] = useState(false);
  if (editando) {
    return (
      <div className="pizarra-fila pizarra-fila--hoja">
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
    );
  }
  return (
    <div
      className={clsx("pizarra-fila pizarra-fila--hoja", {
        "pizarra-fila--activa": activa,
      })}
      onClick={() => pizarra.abrirHoja(proyectoId!, hoja.id)}
      onDoubleClick={() => setEditando(true)}
    >
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
          titulo="Renombrar"
          icono={pencilIcon}
          onClick={() => setEditando(true)}
        />
        {!(primera && ultima) && (
          <BotonIcono
            titulo="Borrar hoja"
            icono={TrashIcon}
            peligro
            onClick={onBorrar}
          />
        )}
      </span>
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
          {proyecto.hojas.map((hoja, i) => (
            <FilaHoja
              key={hoja.id}
              hoja={hoja}
              activa={hoja.id === hojaId}
              primera={i === 0}
              ultima={i === proyecto.hojas.length - 1}
              onBorrar={() => onBorrar({ tipo: "hoja", hoja })}
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
  const [docked, setDocked] = useState(() => {
    try {
      return localStorage.getItem("pizarra:panel-fijo") === "true";
    } catch {
      return false;
    }
  });
  const [creandoProyecto, setCreandoProyecto] = useState(false);
  const [borrado, setBorrado] = useState<Borrado | null>(null);

  return (
    <Sidebar
      name={SIDEBAR_PIZARRA}
      docked={docked}
      onDock={(fijo) => {
        setDocked(fijo);
        try {
          localStorage.setItem("pizarra:panel-fijo", String(fijo));
        } catch {
          // preferencia de este navegador, no hace falta que persista
        }
      }}
      className="pizarra-sidebar"
    >
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
              : "La hoja se mueve a la papelera de pc3."}
          </p>
        </ConfirmDialog>
      )}
    </Sidebar>
  );
};

/** Botón de arriba a la derecha: proyecto y hoja actuales, abre el panel. */
export const PizarraTrigger = ({ compacto }: { compacto: boolean }) => {
  const estado = useAtomValue(pizarraAtom);
  const proyecto = estado.proyectos.find((p) => p.id === estado.proyectoId);
  const hoja = proyecto?.hojas.find((h) => h.id === estado.hojaId);
  return (
    <Sidebar.Trigger
      name={SIDEBAR_PIZARRA}
      title="Proyectos y hojas"
      icon={LibraryIcon}
      className="pizarra-trigger"
    >
      <span className="pizarra-trigger__texto">
        {!compacto && proyecto && (
          <span className="pizarra-trigger__proyecto">
            {proyecto.nombre} ›{" "}
          </span>
        )}
        {hoja?.nombre ?? "…"}
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

/** Pestañas de hojas en el pie (solo escritorio y tablet). */
export const PizarraHojas = () => {
  const estado = useAtomValue(pizarraAtom);
  const proyecto = estado.proyectos.find((p) => p.id === estado.proyectoId);
  const [editando, setEditando] = useState<string | null>(null);
  const [creando, setCreando] = useState(false);
  if (!proyecto) {
    return null;
  }
  return (
    <div className="pizarra-pestanas">
      {proyecto.hojas.map((hoja) =>
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
              "pizarra-pestana--activa": hoja.id === estado.hojaId,
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

"use client";
import { useRef, useState } from "react";

type Props = {
  accept?: string;
  onFiles: (files: File[]) => void | Promise<void>;
  label?: string;
  multiple?: boolean;
  disabled?: boolean;
};

export default function FileDrop({ accept = ".pdf", onFiles, label = "Drag & drop or click to choose file", multiple = false, disabled = false }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setDrag(false);
        if (disabled) return;
        const files = Array.from(e.dataTransfer.files);
        if (files.length) await onFiles(multiple ? files : [files[0]]);
      }}
      onClick={() => !disabled && inputRef.current?.click()}
      className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition ${
        drag ? "border-blue-500 bg-blue-50" : "border-zinc-300 bg-white"
      } ${disabled ? "opacity-50 pointer-events-none" : "hover:border-zinc-400"}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onClick={(e) => e.stopPropagation()}
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) await onFiles(files);
          e.target.value = "";
        }}
      />
      <div className="text-sm text-zinc-600">{label}</div>
      <div className="text-xs text-zinc-400 mt-1">Accepted: {accept}</div>
    </div>
  );
}

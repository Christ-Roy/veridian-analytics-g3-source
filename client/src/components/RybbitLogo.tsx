/**
 * Logos de l'application.
 *
 * Le nom des composants reste `RybbitLogo` / `RybbitTextLogo` DÉLIBÉRÉMENT : ils
 * sont importés depuis des dizaines de fichiers upstream, et les renommer
 * transformerait chaque synchro amont en corvée de résolution de conflits pour
 * un gain nul (un nom de composant n'est jamais vu par un client).
 *
 * Ce qui est visible, lui, vient entièrement de `BRAND`.
 */
import Image from "next/image";
import { useEffect, useState } from "react";
import { useWhiteLabel } from "../hooks/useIsWhiteLabel";
import { BRAND } from "../lib/brand";
import { Skeleton } from "./ui/skeleton";

function getTextLogoHeight(width: number, height?: number) {
  return height && height > 0 ? height : Math.round(width / BRAND.logo.horizontalAspectRatio);
}

export function RybbitLogo({ width = 32, height = 32 }: { width?: number; height?: number }) {
  const { whiteLabelImage, isPending } = useWhiteLabel();
  const [mounted, setMounted] = useState(false);
  const imageStyle = { width, height, objectFit: "contain" as const };

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || isPending) {
    return <Skeleton style={{ width, height }} />;
  }

  // Une organisation en marque blanche (revente sous la marque d'un client)
  // continue de primer sur la marque Veridian.
  return (
    <Image
      src={whiteLabelImage || BRAND.logo.mark}
      alt={BRAND.name}
      width={width}
      height={height}
      style={imageStyle}
    />
  );
}

export function RybbitTextLogo({ width = 150, height }: { width?: number; height?: number }) {
  const { whiteLabelImage, isPending } = useWhiteLabel();
  const [mounted, setMounted] = useState(false);
  const resolvedHeight = getTextLogoHeight(width, height);
  const imageStyle = { width, height: resolvedHeight, objectFit: "contain" as const };

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || isPending) {
    return <Skeleton style={{ width, height: resolvedHeight }} />;
  }

  return (
    <Image
      src={whiteLabelImage || BRAND.logo.horizontal}
      alt={BRAND.name}
      width={width}
      height={resolvedHeight}
      style={imageStyle}
      loading="eager"
    />
  );
}

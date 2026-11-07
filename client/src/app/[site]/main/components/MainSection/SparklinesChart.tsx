"use client";
import { useNivoTheme } from "@/lib/nivo";
import { ResponsiveLine } from "@nivo/line";
import { DateTime } from "luxon";

export function SparklinesChart({
  data,
  isHovering,
}: {
  data: { value: number; time: string }[] | undefined;
  isHovering: boolean;
}) {
  const nivoTheme = useNivoTheme();

  const formattedData = data
    ?.map((e, i) => {
      // filter out dates from the future
      if (DateTime.fromSQL(e.time).toUTC() > DateTime.now()) {
        return null;
      }

      return {
        x: DateTime.fromSQL(e.time).toUTC().toFormat("yyyy-MM-dd HH:mm:ss"),
        y: e.value,
        currentTime: DateTime.fromSQL(e.time),
      };
    })
    .filter(e => e !== null);

  /**
   * 🔴 UNE SÉRIE VIDE FAIT ÉCRIRE `d="null"` DANS LE SVG.
   *
   * `data ?? []` passait un tableau vide à nivo, dont le générateur de tracé
   * rend `null` faute de point. React écrit alors littéralement `d="null"`, et
   * le navigateur refuse l'attribut : « Expected moveto path command ('M' or
   * 'm'), "null" ». La tuile n'affiche rien de faux — le tracé est vide de
   * toute façon — donc le défaut est INVISIBLE à l'œil et n'a été trouvé que
   * par le balayage d'écrans, qui lit la console. Dix-huit erreurs par
   * chargement de la page d'accueil, une par tuile.
   *
   * Ce n'est pas cosmétique : une console qui hurle en permanence est une
   * console qu'on cesse de lire, et c'est là que se cachera la prochaine
   * vraie erreur de rendu.
   *
   * Deux cas mènent ici et ils sont tous deux légitimes : la donnée n'est pas
   * encore arrivée, ou le site n'a aucune mesure sur la période. Dans les deux
   * cas il n'y a pas de courbe à tracer, et ne rien rendre est la réponse
   * juste. Le conteneur garde sa place, la tuile ne saute pas.
   */
  if (!formattedData || formattedData.length === 0) {
    return null;
  }

  return (
    <ResponsiveLine
      data={[
        {
          id: "1",
          data: formattedData,
        },
      ]}
      theme={nivoTheme}
      margin={{ top: 5, right: 0, bottom: 0, left: 0 }}
      xScale={{
        type: "time",
        format: "%Y-%m-%d %H:%M:%S",
        precision: "second",
        useUTC: true,
      }}
      yScale={{
        type: "linear",
        min: 0,
        stacked: false,
        reverse: false,
      }}
      enableGridX={false}
      enableGridY={false}
      gridYValues={4}
      yFormat=" >-.2f"
      axisTop={null}
      axisRight={null}
      axisBottom={null}
      axisLeft={null}
      enableTouchCrosshair={true}
      enablePoints={false}
      useMesh={true}
      animate={false}
      enableSlices={"x"}
      colors={[isHovering ? "hsl(var(--dataviz-2))" : "hsl(var(--dataviz))"]}
      enableArea={false}
      areaBaselineValue={0}
      areaOpacity={0.3}
      defs={[
        {
          id: "gradient",
          type: "linearGradient",
          colors: [
            { offset: 0, color: "hsl(var(--dataviz))", opacity: 1 },
            { offset: 100, color: "hsl(var(--dataviz))", opacity: 0 },
          ],
        },
      ]}
      curve="step"
      fill={[{ match: d => d.id === "1", id: "gradient" }]}
      sliceTooltip={() => null}
      enableCrosshair={false}
    />
  );
}

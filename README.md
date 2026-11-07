# Veridian Analytics (G3) : code source publié

**Français.** Ce dépôt publie le code source de Veridian Analytics G3, un fork de [Rybbit](https://github.com/rybbit-io/rybbit) (analytics web open source). Le fork d'origine est `rybbit-io/rybbit`, commit de fork `9ec40e2c` (16 août 2026), version applicative `2.8.0`. Le code publié correspond au commit `16b065ac3` de la branche `main`, en production. Les modifications Veridian sont décrites dans [`VERIDIAN-FORK.md`](VERIDIAN-FORK.md). Ce dépôt est un instantané sans historique, destiné à la lecture, à la reconstruction et au respect de l'AGPL. Il ne contient ni la configuration de déploiement ni les secrets.

Licence : GNU Affero General Public License v3, voir [`LICENSE.md`](LICENSE.md). Le copyright d'origine reste dans les fichiers.

**English.** This repository publishes the source code of Veridian Analytics G3, a fork of [Rybbit](https://github.com/rybbit-io/rybbit) (open-source web analytics). The upstream is `rybbit-io/rybbit`, fork commit `9ec40e2c` (16 August 2026), application version `2.8.0`. The published code matches commit `16b065ac3` on the `main` branch, which runs in production. Veridian modifications are described in [`VERIDIAN-FORK.md`](VERIDIAN-FORK.md). This is a snapshot without history, for reading, rebuilding and AGPL compliance. It contains no deployment configuration and no secrets.

License: GNU Affero General Public License v3, see [`LICENSE.md`](LICENSE.md). Original copyright notices are kept in the files.


## GeoIP / MaxMind

Les bases `GeoLite2-City.mmdb` et `GeoLite2-ASN.mmdb` ne sont pas redistribuées ici, leur licence MaxMind l'encadre. Téléchargez-les avec votre compte MaxMind et placez-les dans `server/`.

The GeoLite2 databases are not redistributed here. Download them with your MaxMind account and place them in `server/`.

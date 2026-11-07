/**
 * Le plugin `magicLink` applique une seule limite à l'envoi du mail et à la vérification
 * du lien : 3 par minute et par IP. Sur l'envoi elle freine l'abus. Sur la vérification,
 * elle coupait le 4e collègue d'un même bureau, puisqu'ils sortent par la même IP.
 *
 * Le jeton de ce lien est aléatoire, à usage unique, et son émission est plafonnée par
 * utilisateur : ici, la limite ne sert qu'à freiner les essais de jetons.
 */
export const magicLinkVerifyRateLimitRules = {
  "/magic-link/verify": { window: 60, max: 120 },
};

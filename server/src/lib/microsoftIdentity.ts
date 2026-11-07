/**
 * Identifiant, constant chez Microsoft, du « tenant » qui héberge TOUS les
 * comptes Microsoft personnels (outlook.com, hotmail.fr, live.fr). Chaque jeton
 * émis pour un compte personnel le porte dans son claim `tid` : c'est le seul
 * moyen de distinguer un compte grand public d'un compte d'entreprise.
 * @see https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference
 */
export const MICROSOFT_CONSUMER_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

/**
 * L'adresse portée par un jeton Entra est-elle une PREUVE d'identité ?
 *
 * 🔴 C'est la parade à « nOAuth ». Sur une application multi-tenant, le claim
 * `email` n'engage personne : n'importe qui peut créer son propre annuaire
 * Entra, y déclarer un utilisateur portant l'adresse de sa victime, et se
 * connecter chez nous avec. better-auth ne rattache un compte social à un
 * compte existant que si `emailVerified` est vrai — donc ce booléen décide
 * littéralement d'une prise de contrôle de compte.
 *
 * Deux cas, et deux seulement, valent preuve :
 *
 *  - `xms_edov` (« email domain owner verified ») : Microsoft atteste que le
 *    tenant émetteur POSSÈDE le domaine de l'adresse. C'est la parade que
 *    Microsoft recommande lui-même. Le claim doit être demandé sur l'App
 *    Registration (`optionalClaims.idToken`), sinon il n'est pas émis — et son
 *    absence vaut alors « non prouvé », jamais « prouvé ».
 *  - le tenant des comptes personnels : Microsoft vérifie l'adresse à la
 *    création du compte. C'est ce cas qui couvre les Outlook/Hotmail grand
 *    public, raison d'être même du bouton.
 *
 * Tout le reste — y compris un compte d'entreprise parfaitement légitime dont
 * le tenant n'a pas fait vérifier son domaine — est traité comme non prouvé.
 * La conséquence est bénigne et volontairement du côté sûr : ce compte ne sera
 * pas rattaché automatiquement à un compte existant.
 *
 * ⚠️ Microsoft sérialise parfois `xms_edov` en chaîne, d'où le double test :
 * ne pas s'y fier ferait silencieusement retomber tout le monde sur « non
 * prouvé », c'est-à-dire sur un login qui échoue sans rien dire d'utile.
 */
export function isMicrosoftEmailProven(profile: {
  xms_edov?: unknown;
  tid?: unknown;
  // Le jeton porte des dizaines d'autres claims : les accepter évite d'avoir à
  // les énumérer ici, et permet aux tests de passer un profil réaliste.
  [claim: string]: unknown;
}): boolean {
  return profile.xms_edov === true || profile.xms_edov === "true" || profile.tid === MICROSOFT_CONSUMER_TENANT_ID;
}

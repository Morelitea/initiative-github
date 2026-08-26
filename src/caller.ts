/**
 * Who a call is for, once the token that carried it has been put away.
 *
 * Its own module for the same reason `public-id.ts` is: the dispatcher builds
 * one and the handlers read one, so a type living in either would make the two
 * import each other.
 *
 * Two kinds of token reach this app and both terminate here. A context token
 * carries this app's own connection ref outright; a delegation token names the
 * member by a pairwise subject that Initiative maps to the identical handle.
 * What survives is "the member you know as `ref-abc`" — never a name, an email
 * or an Initiative user id — so nothing downstream can tell the two apart, and
 * nothing downstream learns who the person is.
 */

export interface Caller {
  guildId: number;
  appInstallId: number;
  /**
   * The member's connection handle, or null when they have connected no GitHub
   * account.
   *
   * Null is the ordinary state rather than an error, and the two directions
   * answer it differently: a read says so in a shape the widget draws, a write
   * refuses outright.
   */
  connectionRef: string | null;
}

// Notifier interface: sends pipeline events and weather alerts (console, or Amazon SNS email with NOTIFIER=sns).

export class Notifier {
  /**
   * @param {{ level: "info"|"warn"|"error", title: string, message?: string, data?: object }} event
   */
  async notify(event) { throw new Error("Notifier.notify not implemented"); }
}

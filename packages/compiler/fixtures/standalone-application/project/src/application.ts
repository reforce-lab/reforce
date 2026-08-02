import {
  Injectable,
  type OnContextClose,
  type OnContextStart,
} from "@reforce/context";

export interface GreetingPort {
  value(): string;
}

@Injectable()
export class MessageRepository implements GreetingPort {
  value(): string {
    return "hello";
  }
}

@Injectable()
export class GreetingService implements OnContextStart, OnContextClose {
  static readonly events: string[] = [];

  readonly #repository: GreetingPort;

  constructor(repository: GreetingPort) {
    this.#repository = repository;
  }

  onContextStart(): void {
    GreetingService.events.push("start");
  }

  onContextClose(): void {
    GreetingService.events.push("close");
  }

  greet(): string {
    return this.#repository.value();
  }
}

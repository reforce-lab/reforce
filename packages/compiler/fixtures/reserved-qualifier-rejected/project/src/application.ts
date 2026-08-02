import { Injectable, Qualifier } from "@reforce/context";

export interface JobPort {}

@Qualifier("enum")
@Injectable()
export class JobService implements JobPort {}

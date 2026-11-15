// Restore a 0.1.10 backup on a fresh 0.2.0. The checks live in upgrade.suite.ts.
import { upgradeSuite } from "./upgrade.suite.ts";

upgradeSuite("0.1.10");

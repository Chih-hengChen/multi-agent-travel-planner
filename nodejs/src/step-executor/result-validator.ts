export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

type ValidatorFn = (output: Record<string, unknown>) => ValidationResult;

const VALIDATORS: Record<string, ValidatorFn> = {
  transport_search: (output) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const outbound = output.outbound as unknown[];
    const returnOpts = output.return as unknown[];

    if (!outbound || outbound.length === 0) {
      errors.push("去程为空");
    }
    if (!returnOpts || returnOpts.length === 0) {
      errors.push("返程为空");
    }

    if (outbound && outbound.length > 0) {
      const first = outbound[0] as Record<string, unknown>;
      if (typeof first.price !== "number" || (first.price as number) <= 0) {
        errors.push("去程价格必须为正数");
      }
    }

    if (returnOpts && returnOpts.length > 0) {
      const first = returnOpts[0] as Record<string, unknown>;
      if (typeof first.price !== "number" || (first.price as number) <= 0) {
        errors.push("返程价格必须为正数");
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  },

  hotel_search: (output) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const hotels = output.hotels as unknown[];

    if (!hotels || hotels.length === 0) {
      errors.push("酒店结果为空");
    }

    return { valid: errors.length === 0, errors, warnings };
  },

  plan_result: (output) => {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!output.destination) {
      errors.push("缺少目的地");
    }
    if (!output.totalCost && (output.totalCost as number) <= 0) {
      warnings.push("总费用未计算");
    }
    if (!output.days || (output.days as number) <= 0) {
      errors.push("行程天数无效");
    }
    if (!output.outboundFlights && !output.trainOutbound) {
      warnings.push("缺少去程交通信息");
    }
    if (!output.returnFlights && !output.trainReturn) {
      warnings.push("缺少返程交通信息");
    }

    return { valid: errors.length === 0, errors, warnings };
  },
};

export class ResultValidator {
  validate(validatorName: string, output: Record<string, unknown>): ValidationResult {
    const validator = VALIDATORS[validatorName];
    if (!validator) {
      return { valid: true, errors: [], warnings: [] };
    }
    return validator(output);
  }

  register(name: string, fn: ValidatorFn): void {
    VALIDATORS[name] = fn;
  }
}

export const resultValidator = new ResultValidator();

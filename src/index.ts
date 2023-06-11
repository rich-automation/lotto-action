import * as core from '@actions/core';
import { createWaitingIssue, getWaitingIssues, initLabels, markIssueAsChecked, rankToLabel } from './internal/issues';
import { getCurrentLottoRound, LogLevel, LottoService } from '@rich-automation/lotto';
import { inputKeys } from './internal/constants';
import type { LottoServiceInterface } from '@rich-automation/lotto/lib/typescript/types';
import { bodyBuilder, bodyParser } from './internal/bodyHandlers';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { installBrowser } from './internal/installBrowser';

dayjs.extend(utc);
dayjs.extend(timezone);

async function run() {
  try {
    await runInitRepo();

    const lottoService = await runActionsEnvironments();
    await runWinningCheck(lottoService);
    await runPurchase(lottoService);
  } catch (e) {
    if (e instanceof Error) {
      core.info(`💸 GitHub Actions 실행에 실패했습니다. ${e}`);
      core.setFailed(e.message);
    }
  } finally {
    process.exit(0);
  }
}
async function runActionsEnvironments() {
  core.info(`💸 기본 환경을 설정하고 로그인을 진행합니다.`);

  const controller = 'playwright';
  await installBrowser(controller);

  const id = core.getInput(inputKeys.lottoId);
  const pwd = core.getInput(inputKeys.lottoPassword);

  const lottoService = new LottoService({
    controller,
    headless: true,
    logLevel: LogLevel.DEBUG,
    args: ['--no-sandbox']
  });

  if (id !== '' && pwd !== '') {
    await lottoService.signIn(id, pwd);
  }

  return lottoService;
}

async function runInitRepo() {
  await initLabels();
}

async function runWinningCheck(service: LottoServiceInterface) {
  core.info(`💸 당첨 발표를 확인합니다.`);

  const waitingIssues = await getWaitingIssues();
  if (waitingIssues.length > 0) {
    core.info(`💸 총 ${waitingIssues.length}개의 구매 내역에 대해서 확인합니다.`);

    const promises = waitingIssues.map(async issue => {
      if (issue.body) {
        const { numbers, round } = bodyParser(issue.body);

        const checkPromises = numbers.map(async number => {
          const { rank } = await service.check(number, round);
          return rank;
        });
        const ranks = await Promise.all(checkPromises);

        const rankLabels = [...new Set(ranks.map(it => rankToLabel(it)))];
        await markIssueAsChecked(issue.number, rankLabels);
      }
    });

    const result = await Promise.allSettled(promises);
    const rejectedIssues = result.filter(it => it.status === 'rejected');
    if (rejectedIssues.length > 0) {
      core.info(`💸 ${rejectedIssues.length}개의 당첨 발표를 확인하는 중 오류가 발생했습니다.`);
    }
  } else {
    core.info('💸 확인 할 구매 내역이 없습니다.');
  }
}

async function runPurchase(service: LottoServiceInterface) {
  core.info('💸 로또를 구매합니다.');

  try {
    const amountInput = Number(core.getInput(inputKeys.lottoPurchaseAmount)) || 5;
    const amount = Math.max(1, Math.min(amountInput, 5));

    const date = dayjs.tz(dayjs(), 'Asia/Seoul').format('YYYY-MM-DD');
    const numbers = await service.purchase(amount);
    core.info('💸 로또 구매 완료!');

    const round = getCurrentLottoRound() + 1;
    const link = service.getCheckWinningLink(round, numbers);

    core.info('💸 구매 내역에 대한 이슈를 생성합니다.');
    const issueBody = bodyBuilder({ date, round, numbers, link });
    await createWaitingIssue(date, issueBody);
    core.info('💸 이슈 생성 완료.');
  } catch (e) {
    await service.destroy();

    if (e instanceof Error) {
      core.info(`💸 로또 구매에 실패했습니다. ${e}`);
      core.setFailed(e.message);
    }
  }
}

run();
